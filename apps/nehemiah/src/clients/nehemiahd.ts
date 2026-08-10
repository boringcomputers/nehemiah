import { isIP } from 'node:net';
import type { HostCredentialResolver } from '../domain/host-credentials.js';
import { EgressPolicy, type NetworkPolicyDeclaration } from '../domain/network-policy.js';
import { injectTraceHeaders } from '../telemetry.js';

export interface HostMachine {
	readonly id: string;
	readonly status: string;
	readonly lease_id?: string;
	readonly lease_generation?: number;
	readonly metadata?: Readonly<Record<string, string>>;
	readonly ready?: boolean;
	readonly started_at?: string;
	readonly ready_at?: string;
	readonly expires_at?: string;
	readonly resources?: {
		readonly vcpus: number;
		readonly memory_mb: number;
		readonly disk_mb: number;
	};
	readonly network_policy?: NetworkPolicyDeclaration;
	readonly runtime_cohort_id?: string;
	readonly source_sha256?: string;
}

export interface HostExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exit_code: number | null;
	readonly timed_out: boolean;
	readonly duration_ms: number;
}

export interface CreateOnHostRequest {
	readonly leaseId: string;
	readonly leaseGeneration?: number;
	readonly idempotencyKey: string;
	readonly template?: string;
	readonly ociReference?: string;
	readonly ttlSeconds: number;
	readonly resources: {
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskMb: number;
	};
	readonly networkPolicy: NetworkPolicyDeclaration;
	readonly metadata: Readonly<Record<string, string>>;
	readonly runtimeCohortId?: string;
	readonly sourceSha256?: string;
}

export interface ForkOnHostChild {
	readonly leaseId: string;
	readonly leaseGeneration?: number;
	readonly expiresAt: Date;
	readonly networkPolicy: NetworkPolicyDeclaration;
	readonly resources: {
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskMb: number;
	};
	readonly metadata: Readonly<Record<string, string>>;
	readonly runtimeCohortId?: string;
	readonly sourceSha256?: string;
}

export interface HostClient {
	create(address: string, request: CreateOnHostRequest): Promise<HostMachine>;
	get(address: string, hostMachineId: string): Promise<HostMachine | undefined>;
	destroy(address: string, hostMachineId: string, leaseId: string): Promise<void>;
	extend(
		address: string,
		hostMachineId: string,
		leaseId: string,
		idempotencyKey: string,
		targetExpiresAt: Date
	): Promise<HostMachine>;
	fork(
		address: string,
		sourceHostMachineId: string,
		sourceLeaseId: string,
		idempotencyKey: string,
		children: ReadonlyArray<ForkOnHostChild>
	): Promise<ReadonlyArray<HostMachine>>;
	exec(
		address: string,
		hostMachineId: string,
		leaseId: string,
		command: string,
		timeoutSeconds: number
	): Promise<HostExecResult>;
}

export class HostRequestError extends Error {
	constructor(
		readonly status: number | undefined,
		message: string,
		readonly ambiguous: boolean,
		readonly code?: string
	) {
		super(message);
	}
}

export class HostForkContractError extends HostRequestError {
	constructor(
		message: string,
		readonly observed: ReadonlyArray<HostMachine>
	) {
		super(undefined, message, true);
	}
}

export class NehemiahdClient implements HostClient {
	constructor(
		private readonly credentials: string | HostCredentialResolver,
		private readonly fetcher: typeof fetch = fetch,
		private readonly requestTimeoutMs = 30_000,
		private readonly hostPort = 8080
	) {
		if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
			throw new Error('host port must be between 1 and 65535');
		}
	}

	async create(address: string, request: CreateOnHostRequest): Promise<HostMachine> {
		if (!request.runtimeCohortId || !request.sourceSha256) {
			throw new HostRequestError(
				undefined,
				'managed host create requires an immutable runtime cohort and source digest',
				false,
				'invalid_runtime_binding'
			);
		}
		const machine = await this.request<HostMachine>(address, '/internal/v1/machines', {
			method: 'POST',
			headers: { 'idempotency-key': request.idempotencyKey },
			body: JSON.stringify({
				lease_id: request.leaseId,
				lease_generation: request.leaseGeneration ?? 1,
				template: request.template,
				oci_reference: request.ociReference,
				ttl_seconds: request.ttlSeconds,
				// Managed guests always receive a NIC so the host can reach preview
				// ports. nehemiahd installs a per-tap deny rule, so this does not grant
				// outbound internet access without a future explicit egress policy.
				net: true,
				vcpus: request.resources.vcpus,
				memory_mb: request.resources.memoryMb,
				disk_mb: request.resources.diskMb,
				network_policy: request.networkPolicy,
				metadata: request.metadata,
				runtime_cohort_id: request.runtimeCohortId,
				source_sha256: request.sourceSha256
			})
		});
		let observedPolicy: NetworkPolicyDeclaration | undefined;
		try {
			if (machine.network_policy) {
				observedPolicy = new EgressPolicy(machine.network_policy).declaration;
			}
		} catch {
			// The contract check below converts malformed host policy JSON into an
			// ambiguous response, preserving reconciliation and cleanup semantics.
		}
		if (
			machine.lease_id !== request.leaseId ||
			machine.lease_generation !== (request.leaseGeneration ?? 1) ||
			machine.metadata?.public_machine_id !== request.metadata.public_machine_id ||
			machine.resources?.vcpus !== request.resources.vcpus ||
			machine.resources?.memory_mb !== request.resources.memoryMb ||
			machine.resources?.disk_mb !== request.resources.diskMb ||
			machine.runtime_cohort_id !== request.runtimeCohortId ||
			machine.source_sha256 !== request.sourceSha256 ||
			JSON.stringify(observedPolicy) !== JSON.stringify(request.networkPolicy)
		) {
			throw new HostRequestError(
				undefined,
				'host create response did not match the requested lease and resources',
				true
			);
		}
		return machine;
	}

	async get(address: string, hostMachineId: string): Promise<HostMachine | undefined> {
		try {
			return await this.request(
				address,
				`/internal/v1/machines/${encodeURIComponent(hostMachineId)}`
			);
		} catch (error) {
			if (error instanceof HostRequestError && error.status === 404) return undefined;
			throw error;
		}
	}

	async destroy(address: string, hostMachineId: string, leaseId: string): Promise<void> {
		await this.request(address, `/internal/v1/machines/${encodeURIComponent(hostMachineId)}`, {
			method: 'DELETE',
			headers: { 'x-nehemiah-lease-id': leaseId }
		});
	}

	async extend(
		address: string,
		hostMachineId: string,
		leaseId: string,
		idempotencyKey: string,
		targetExpiresAt: Date
	): Promise<HostMachine> {
		const machine = await this.request<HostMachine>(
			address,
			`/internal/v1/machines/${encodeURIComponent(hostMachineId)}/extend`,
			{
				method: 'POST',
				headers: {
					'x-nehemiah-lease-id': leaseId,
					'idempotency-key': idempotencyKey
				},
				body: JSON.stringify({ expires_at: targetExpiresAt.toISOString() })
			}
		);
		const expiresAt = machine.expires_at ? new Date(machine.expires_at) : undefined;
		if (
			machine.lease_id !== leaseId ||
			!expiresAt ||
			!Number.isFinite(expiresAt.getTime()) ||
			expiresAt < targetExpiresAt
		) {
			throw new HostRequestError(
				undefined,
				'host extend response did not match the requested lease and expiry',
				true
			);
		}
		return machine;
	}

	async fork(
		address: string,
		sourceHostMachineId: string,
		sourceLeaseId: string,
		idempotencyKey: string,
		children: ReadonlyArray<ForkOnHostChild>
	): Promise<ReadonlyArray<HostMachine>> {
		if (children.some((child) => !child.runtimeCohortId || !child.sourceSha256)) {
			throw new HostRequestError(
				undefined,
				'managed host fork requires immutable runtime cohort and source digests',
				false,
				'invalid_runtime_binding'
			);
		}
		let response: { machines: HostMachine[] };
		try {
			response = await this.request<{ machines: HostMachine[] }>(
				address,
				`/internal/v1/machines/${encodeURIComponent(sourceHostMachineId)}/fork`,
				{
					method: 'POST',
					headers: {
						'x-nehemiah-lease-id': sourceLeaseId,
						'idempotency-key': idempotencyKey
					},
					body: JSON.stringify({
						children: children.map((child) => ({
							lease_id: child.leaseId,
							lease_generation: child.leaseGeneration ?? 1,
							expires_at: child.expiresAt.toISOString(),
							vcpus: child.resources.vcpus,
							memory_mb: child.resources.memoryMb,
							disk_mb: child.resources.diskMb,
							metadata: child.metadata,
							runtime_cohort_id: child.runtimeCohortId,
							source_sha256: child.sourceSha256
						}))
					})
				}
			);
		} catch (error) {
			// Capacity rejection happens before the host starts a managed fork and
			// therefore has a definite, replayable result rather than an ambiguous one.
			if (error instanceof HostRequestError && error.status === 429) {
				throw new HostRequestError(error.status, error.message, false, error.code);
			}
			throw error;
		}
		const candidate = response as unknown;
		const rawMachines =
			typeof candidate === 'object' && candidate !== null && 'machines' in candidate
				? Reflect.get(candidate, 'machines')
				: undefined;
		const inspectable = Array.isArray(rawMachines)
			? rawMachines.filter(
					(value): value is HostMachine => typeof value === 'object' && value !== null
				)
			: [];
		if (
			!Array.isArray(rawMachines) ||
			rawMachines.length !== children.length ||
			inspectable.length !== rawMachines.length
		) {
			throw new HostForkContractError(
				'host fork response did not contain the full batch',
				inspectable
			);
		}
		const machines = inspectable;
		const requested = new Map(
			children.map((child) => [child.metadata.public_machine_id, child] as const)
		);
		const observed = new Set<string>();
		const hostIds = new Set<string>();
		for (const machine of machines) {
			const publicMachineId = machine.metadata?.public_machine_id;
			const child = publicMachineId ? requested.get(publicMachineId) : undefined;
			const expiresAt = machine.expires_at ? new Date(machine.expires_at) : undefined;
			const startedAt = machine.started_at ? new Date(machine.started_at) : undefined;
			const readyAt = machine.ready_at ? new Date(machine.ready_at) : undefined;
			let observedPolicy: NetworkPolicyDeclaration | undefined;
			try {
				if (machine.network_policy) {
					observedPolicy = new EgressPolicy(machine.network_policy).declaration;
				}
			} catch {
				// The descriptor check below treats malformed policy data as ambiguous.
			}
			if (
				!machine.id ||
				hostIds.has(machine.id) ||
				!publicMachineId ||
				observed.has(publicMachineId) ||
				!child ||
				machine.lease_id !== child.leaseId ||
				machine.lease_generation !== (child.leaseGeneration ?? 1) ||
				machine.metadata?.parent_machine_id !== child.metadata.parent_machine_id ||
				machine.metadata?.fork_operation_id !== child.metadata.fork_operation_id ||
				machine.resources?.vcpus !== child.resources.vcpus ||
				machine.resources?.memory_mb !== child.resources.memoryMb ||
				machine.resources?.disk_mb !== child.resources.diskMb ||
				machine.runtime_cohort_id !== child.runtimeCohortId ||
				machine.source_sha256 !== child.sourceSha256 ||
				JSON.stringify(observedPolicy) !== JSON.stringify(child.networkPolicy) ||
				!expiresAt ||
				!Number.isFinite(expiresAt.getTime()) ||
				expiresAt.getTime() !== child.expiresAt.getTime() ||
				(startedAt !== undefined && !Number.isFinite(startedAt.getTime())) ||
				(readyAt !== undefined && !Number.isFinite(readyAt.getTime()))
			) {
				throw new HostForkContractError(
					'host fork child did not match its reserved descriptor',
					machines
				);
			}
			observed.add(publicMachineId);
			hostIds.add(machine.id);
		}
		return machines;
	}

	async exec(
		address: string,
		hostMachineId: string,
		leaseId: string,
		command: string,
		timeoutSeconds: number
	): Promise<HostExecResult> {
		try {
			return await this.request(
				address,
				`/internal/v1/machines/${encodeURIComponent(hostMachineId)}/exec`,
				{
					method: 'POST',
					headers: { 'x-nehemiah-lease-id': leaseId },
					body: JSON.stringify({ command, timeout_seconds: timeoutSeconds })
				},
				(timeoutSeconds + 5) * 1_000
			);
		} catch (error) {
			// Guest-operation capacity is rejected before the host dials vsock or
			// performs a side effect. A managed guest-agent-unavailable response is
			// likewise emitted only after the vsock dial failed and serial fallback
			// was forbidden, so neither response is ambiguous.
			if (
				error instanceof HostRequestError &&
				((error.status === 429 && error.code === 'guest_operation_capacity_reached') ||
					(error.status === 503 && error.code === 'guest_agent_unavailable'))
			) {
				throw new HostRequestError(error.status, error.message, false, error.code);
			}
			throw error;
		}
	}

	private async request<T>(
		address: string,
		path: string,
		init: RequestInit = {},
		timeoutMs = this.requestTimeoutMs
	): Promise<T> {
		const version = isIP(address);
		if (version === 0) {
			throw new HostRequestError(undefined, 'invalid host address', false);
		}
		const base = `http://${version === 6 ? `[${address}]` : address}:${this.hostPort}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const internalToken =
				typeof this.credentials === 'string'
					? this.credentials
					: await this.credentials.resolve(address);
			const headers = new Headers(init.headers);
			headers.set('accept', 'application/json');
			headers.set('content-type', 'application/json');
			headers.set('authorization', `Bearer ${internalToken}`);
			injectTraceHeaders(headers);
			const response = await this.fetcher(`${base}${path}`, {
				...init,
				signal: controller.signal,
				redirect: 'error',
				headers: Object.fromEntries(headers.entries())
			});
			const bytes = await readBoundedResponse(response, 1 << 20);
			if (!response.ok) {
				const body = new TextDecoder().decode(bytes);
				let code: string | undefined;
				try {
					const decoded = JSON.parse(body) as unknown;
					if (typeof decoded === 'object' && decoded !== null) {
						const candidate = Reflect.get(decoded, 'error');
						if (typeof candidate === 'string') code = candidate;
					}
				} catch {
					// The bounded response body is retained as the diagnostic message below.
				}
				throw new HostRequestError(
					response.status,
					body,
					(response.status >= 500 || response.status === 429 || response.status === 408) &&
						(init.method === 'POST' || init.method === 'DELETE'),
					code
				);
			}
			if (response.status === 204) return undefined as T;
			return JSON.parse(new TextDecoder().decode(bytes)) as T;
		} catch (error) {
			if (error instanceof HostRequestError) throw error;
			throw new HostRequestError(
				undefined,
				error instanceof Error ? error.message : String(error),
				init.method === 'POST' || init.method === 'DELETE'
			);
		} finally {
			clearTimeout(timer);
		}
	}
}

const readBoundedResponse = async (response: Response, maximum: number): Promise<Uint8Array> => {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maximum)
		throw new Error('host response is too large');
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximum) {
			await reader.cancel();
			throw new Error('host response is too large');
		}
		chunks.push(value);
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};
