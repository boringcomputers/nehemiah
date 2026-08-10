import { Effect, Either } from 'effect';
import type { ManagedTemplate, NehemiahClient, NehemiahError } from 'nehemiah-sdk';
import { UsageError, type CommandOutput, type ParsedArgs } from './machines.js';

const run = async <A>(effect: Effect.Effect<A, NehemiahError>): Promise<A> => {
	const result = await Effect.runPromise(Effect.either(effect));
	if (Either.isLeft(result)) throw result.left;
	return result.right;
};

const required = (value: string | undefined, label: string): string => {
	if (!value) throw new UsageError(`Missing ${label}.`);
	return value;
};

const flag = (args: ParsedArgs, name: string): string | undefined => {
	const value = args.flags[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.length === 0) {
		throw new UsageError(`--${name} needs a value.`);
	}
	return value;
};

const summary = (template: ManagedTemplate): string =>
	`${template.name}@${template.version}\t${template.id}\t${template.manifest.architecture}\t${template.size_bytes} bytes`;

export async function runTemplateCommand(
	client: NehemiahClient,
	command: string | undefined,
	args: ParsedArgs
): Promise<CommandOutput> {
	switch (command) {
		case 'publish': {
			throw new UsageError(
				'Managed custom-template publication is disabled until aggregate storage quotas and durable eviction are enforced.'
			);
		}
		case 'list': {
			const project = flag(args, 'project');
			const templates = await run(
				client.listManagedTemplates(project === undefined ? {} : { project })
			);
			return {
				value: { templates },
				human: templates.length === 0 ? 'No managed templates.' : templates.map(summary).join('\n')
			};
		}
		case 'delete': {
			const id = required(args.positionals[0], 'template id');
			const project = flag(args, 'project');
			await run(client.deleteManagedTemplate(id, project === undefined ? {} : { project }));
			return { value: { id, deleted: true }, human: `Deleted template ${id}.` };
		}
		default:
			throw new UsageError(`Unknown template command: ${command ?? ''}`.trim());
	}
}
