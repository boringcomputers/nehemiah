import { Effect, Either } from 'effect';
import { ForkPending } from 'nehemiah-sdk';
import type {
	CreateMachineOptions,
	FileTransferOptions,
	Machine,
	MachineSize,
	NehemiahClient,
	NehemiahError
} from 'nehemiah-sdk';
import { basename } from 'node:path';
import { readBoundedLocalFile, writePrivateAtomic } from '../files.js';

export interface ParsedArgs {
	readonly positionals: ReadonlyArray<string>;
	readonly flags: Readonly<Record<string, string | boolean>>;
}

export interface CommandOutput {
	readonly value?: unknown;
	readonly human?: string;
}

const run = async <A>(effect: Effect.Effect<A, NehemiahError>): Promise<A> => {
	const result = await Effect.runPromise(Effect.either(effect));
	if (Either.isLeft(result)) throw result.left;
	return result.right;
};

export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (!argument.startsWith('--')) {
			positionals.push(argument);
			continue;
		}
		const [rawName, inline] = argument.slice(2).split('=', 2);
		const name = rawName!;
		if (inline !== undefined) {
			flags[name] = inline;
			continue;
		}
		const next = args[index + 1];
		if (next !== undefined && !next.startsWith('--')) {
			flags[name] = next;
			index += 1;
		} else {
			flags[name] = true;
		}
	}
	return { positionals, flags };
}

export async function runMachineCommand(
	client: NehemiahClient,
	command: string,
	args: ParsedArgs
): Promise<CommandOutput> {
	switch (command) {
		case 'create': {
			const hasSource =
				args.flags.template !== undefined ||
				args.flags['template-id'] !== undefined ||
				args.flags.oci !== undefined;
			const allowedHostnames = listFlag(args.flags, 'allow-hostnames');
			const allowedCidrs = listFlag(args.flags, 'allow-cidrs');
			if (allowedHostnames.length > 0 || allowedCidrs.length > 0) {
				throw new UsageError(
					'--allow-hostnames and --allow-cidrs are unavailable; managed cloud is network-off and public local/self-hosted routes use only the legacy --net switch.'
				);
			}
			const options: CreateMachineOptions = {
				...(!hasSource && client.target === 'cloud' ? { template: 'desktop' } : {}),
				...optionalString(args.flags, 'template'),
				...renamedString(args.flags, 'template-id', 'templateId'),
				...renamedString(args.flags, 'oci', 'ociReference'),
				...optionalString(args.flags, 'project'),
				...optionalString(args.flags, 'region'),
				...enumFlag(args.flags, 'size', ['small', 'medium', 'large'] as const),
				...renamedNumber(args.flags, 'ttl', 'ttlSeconds'),
				...renamedString(args.flags, 'idempotency-key', 'idempotencyKey'),
				...(args.flags.net === true ? { net: true } : {}),
				...optionalString(args.flags, 'volume'),
				...resources(args.flags)
			};
			const machine = await run(client.createMachine(options));
			return { value: machine, human: machineSummary(machine) };
		}
		case 'list': {
			const page = await run(
				client.listMachinesPage({
					...optionalString(args.flags, 'project'),
					...optionalString(args.flags, 'cursor'),
					...optionalNumber(args.flags, 'limit')
				})
			);
			return {
				value: {
					machines: page.machines,
					next_cursor: page.nextCursor,
					metadata: page.metadata
				},
				human: page.machines.length ? page.machines.map(machineSummary).join('\n') : 'No machines.'
			};
		}
		case 'get': {
			const id = required(args.positionals[0], 'machine id');
			const machine = await run(client.getMachine(id));
			return { value: machine, human: JSON.stringify(machine, null, 2) };
		}
		case 'exec': {
			const id = required(args.positionals[0], 'machine id');
			const commandText = stringFlag(args.flags, 'command') ?? args.positionals.slice(1).join(' ');
			required(commandText, 'command');
			const result = await run(
				client.exec(id, commandText, {
					...renamedNumber(args.flags, 'timeout', 'timeoutSeconds')
				})
			);
			const combined = result.output ?? `${result.stdout ?? ''}${result.stderr ?? ''}`;
			return {
				value: result,
				human: `${combined}${combined.endsWith('\n') || combined.length === 0 ? '' : '\n'}exit ${String(result.exit_code)}`
			};
		}
		case 'upload': {
			const id = required(args.positionals[0], 'machine id');
			const localPath = required(args.positionals[1], 'local source path');
			const name = stringFlag(args.flags, 'name') ?? basename(localPath);
			const options = fileTransferOptions(args.flags);
			const data = await readBoundedLocalFile(localPath, options.maximumBytes);
			const uploaded = await run(client.uploadFile(id, name, data, options));
			return {
				value: { ...uploaded, local_path: localPath },
				human: `Uploaded ${localPath} to ${uploaded.path} (${uploaded.bytes} bytes).`
			};
		}
		case 'download': {
			const id = required(args.positionals[0], 'machine id');
			const remotePath = required(args.positionals[1], 'remote source path');
			const localPath = required(args.positionals[2], 'local destination path');
			const downloaded = await run(
				client.downloadFile(id, remotePath, fileTransferOptions(args.flags))
			);
			const destination = await writePrivateAtomic(localPath, downloaded.data);
			return {
				value: {
					remote_path: remotePath,
					local_path: destination,
					bytes: downloaded.bytes,
					metadata: downloaded.metadata
				},
				human: `Downloaded ${remotePath} to ${destination} (${downloaded.bytes} bytes).`
			};
		}
		case 'stop': {
			const id = required(args.positionals[0], 'machine id');
			await run(
				client.destroyMachine(id, {
					...renamedString(args.flags, 'idempotency-key', 'idempotencyKey')
				})
			);
			return { value: { id, stopped: true }, human: `Stopped ${id}.` };
		}
		case 'fork': {
			const id = required(args.positionals[0], 'machine id');
			const count = numberFlag(args.flags, 'count') ?? 1;
			try {
				const machines = await run(
					client.branchMachines(id, count, {
						...renamedString(args.flags, 'idempotency-key', 'idempotencyKey')
					})
				);
				return {
					value: { machines },
					human: machines.map(machineSummary).join('\n')
				};
			} catch (error) {
				if (!(error instanceof ForkPending)) throw error;
				const operation = {
					id: error.operation.id,
					state: error.operation.state,
					idempotency_key: error.operation.idempotencyKey,
					source_machine_id: error.operation.sourceMachineId,
					requested: error.operation.requested
				};
				return {
					value: { operation, machines: error.machines },
					human: `Fork ${operation.id} is ${operation.state}. Retry: bc machines fork ${operation.source_machine_id} --count ${operation.requested} --idempotency-key ${operation.idempotency_key}`
				};
			}
		}
		default:
			throw new UsageError(`Unknown machine command: ${command}`);
	}
}

export class UsageError extends Error {
	readonly code = 'usage_error';
}

function machineSummary(machine: Machine): string {
	return `${machine.id}\t${machine.status}${machine.ready === false ? ' (not ready)' : ''}\t${machine.region ?? machine.template ?? machine.template_id ?? ''}`;
}

function required(value: string | undefined, label: string): string {
	if (!value) throw new UsageError(`Missing ${label}.`);
	return value;
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
	const value = flags[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length === 0)
		throw new UsageError(`--${name} needs a value.`);
	return value;
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
	const value = stringFlag(flags, name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number.`);
	return parsed;
}

function optionalString(flags: ParsedArgs['flags'], name: string): Record<string, string> {
	const value = stringFlag(flags, name);
	return value === undefined ? {} : { [name]: value };
}

function listFlag(flags: ParsedArgs['flags'], name: string): string[] {
	const value = flags[name];
	if (typeof value !== 'string') return [];
	return [
		...new Set(
			value
				.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean)
		)
	];
}

function renamedString(
	flags: ParsedArgs['flags'],
	name: string,
	property: string
): Record<string, string> {
	const value = stringFlag(flags, name);
	return value === undefined ? {} : { [property]: value };
}

function optionalNumber(flags: ParsedArgs['flags'], name: string): Record<string, number> {
	const value = numberFlag(flags, name);
	return value === undefined ? {} : { [name]: value };
}

function renamedNumber(
	flags: ParsedArgs['flags'],
	name: string,
	property: string
): Record<string, number> {
	const value = numberFlag(flags, name);
	return value === undefined ? {} : { [property]: value };
}

function enumFlag<const T extends ReadonlyArray<string>>(
	flags: ParsedArgs['flags'],
	name: string,
	values: T
): { readonly size?: MachineSize } {
	const value = stringFlag(flags, name);
	if (value === undefined) return {};
	if (!values.includes(value))
		throw new UsageError(`--${name} must be one of ${values.join(', ')}.`);
	return { size: value as MachineSize };
}

function resources(flags: ParsedArgs['flags']): Pick<CreateMachineOptions, 'resources'> | {} {
	const vcpus = numberFlag(flags, 'vcpus');
	const memoryMb = numberFlag(flags, 'memory-mb');
	const diskMb = numberFlag(flags, 'disk-mb');
	if (vcpus === undefined && memoryMb === undefined && diskMb === undefined) return {};
	return {
		resources: {
			...(vcpus !== undefined ? { vcpus } : {}),
			...(memoryMb !== undefined ? { memoryMb } : {}),
			...(diskMb !== undefined ? { diskMb } : {})
		}
	};
}

function fileTransferOptions(flags: ParsedArgs['flags']): FileTransferOptions {
	return {
		...renamedNumber(flags, 'max-bytes', 'maximumBytes'),
		...renamedNumber(flags, 'timeout-ms', 'timeoutMs'),
		...renamedNumber(flags, 'ttl', 'ttlSeconds')
	};
}
