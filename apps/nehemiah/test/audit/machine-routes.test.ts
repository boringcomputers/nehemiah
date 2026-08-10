import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyService } from '../../src/auth/api-key.js';
import { AuditService } from '../../src/audit/audit.js';
import type { Queryable } from '../../src/db/client.js';
import {
	InvalidMachineRequest,
	type Machine,
	type MachineService
} from '../../src/domain/machines.js';
import type { OrganizationService } from '../../src/domain/organizations.js';
import { HostRequestError } from '../../src/clients/nehemiahd.js';
import { Router } from '../../src/http/router.js';
import {
	registerMachineRoutes,
	type MachineRouteServices
} from '../../src/http/routes/machines.js';

class AuditDatabase implements Queryable {
	readonly calls: ReadonlyArray<unknown>[] = [];

	constructor(
		private readonly fail = false,
		private readonly failAt?: number
	) {}

	async query(_text: string, values: ReadonlyArray<unknown> = []) {
		this.calls.push(values);
		if (this.fail || this.calls.length === this.failAt) throw new Error('audit unavailable');
		return { rows: [], rowCount: 1 } as never;
	}
}

const machine: Machine = {
	id: 'm_audit-route-machine',
	organizationId: '55ea6a17-47bc-472e-b07a-69d5e9f6bc4e',
	projectId: '80ded43c-c6bd-4181-bc8c-594ab0bd3ad2',
	hostId: 'host-1',
	hostAddress: '10.64.0.8',
	hostMachineId: 'local-1',
	leaseId: '40e48f34-038b-4ee2-8809-9d95ea3429ff',
	state: 'running',
	region: 'ca-tor-1',
	architecture: 'x86_64',
	resources: { vcpus: 1, memoryMb: 512, diskMb: 5_120 },
	template: 'python',
	requestedTtlSeconds: 900,
	ready: true,
	createdAt: new Date('2026-08-09T00:00:00.000Z'),
	startedAt: new Date('2026-08-09T00:00:01.000Z'),
	readyAt: new Date('2026-08-09T00:00:02.000Z'),
	expiresAt: new Date('2026-08-09T00:15:00.000Z')
};

const services = (
	database: AuditDatabase,
	machines: Partial<MachineService>
): MachineRouteServices =>
	({
		database,
		apiKeys: {
			authenticate: async () => ({
				kind: 'api_key',
				apiKeyId: 'key-1',
				organizationId: machine.organizationId,
				projectId: machine.projectId,
				scopes: new Set(['machines:read', 'machines:write'])
			})
		} as unknown as ApiKeyService,
		audit: new AuditService(database),
		organizations: {} as OrganizationService,
		machines: machines as MachineService,
		gatewaySecret: 'a sufficiently long gateway signing secret',
		gatewayPublicUrl: 'https://gateway.example.com'
	}) satisfies MachineRouteServices;

const router = (): Router<MachineRouteServices> => {
	const result = new Router<MachineRouteServices>();
	registerMachineRoutes(result);
	return result;
};

describe('machine route audit boundary', () => {
	it('rejects managed OCI before audit intent or machine persistence', async () => {
		const database = new AuditDatabase();
		const create = vi.fn();
		const response = await router().handle(
			new Request('https://api.example.com/v1/machines', {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json',
					'idempotency-key': 'create-oci-route'
				},
				body: JSON.stringify({
					project_id: machine.projectId,
					oci_reference: 'registry.example/image@sha256:deadbeef'
				})
			}),
			services(database, { create })
		);

		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({
			title: 'not_supported',
			status: 501
		});
		expect(database.calls).toHaveLength(1);
		expect(database.calls[0]?.[3]).toBe('succeeded');
		expect(create).not.toHaveBeenCalled();
	});

	it('does not invoke create when durable audit intent is unavailable', async () => {
		const create = vi.fn();
		const response = await router().handle(
			new Request('https://api.example.com/v1/machines', {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json',
					'idempotency-key': 'create-audit-route'
				},
				body: JSON.stringify({ project_id: machine.projectId, template: 'python' })
			}),
			services(new AuditDatabase(true), { create })
		);

		expect(response.status).toBe(500);
		expect(create).not.toHaveBeenCalled();
	});

	it('audits exec metadata without command content or output', async () => {
		const database = new AuditDatabase();
		const command = 'printf super-secret-command';
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/exec`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ command, timeout_seconds: 5 })
			}),
			services(database, {
				get: async () => machine,
				exec: async () => ({
					stdout: 'super-secret-output',
					stderr: '',
					exit_code: 0,
					timed_out: false,
					duration_ms: 3
				})
			})
		);

		expect(response.status).toBe(200);
		expect(database.calls).toHaveLength(3);
		const serializedAudit = JSON.stringify(database.calls);
		expect(serializedAudit).not.toContain(command);
		expect(serializedAudit).not.toContain('super-secret-output');
		expect(
			database.calls.map((values) => values[7]).filter((value) => value !== 'api_key')
		).toEqual(['requested', 'succeeded']);
	});

	it('returns and audits a definite host guest-operation capacity rejection', async () => {
		const database = new AuditDatabase();
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/exec`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ command: 'true', timeout_seconds: 5 })
			}),
			services(database, {
				get: async () => machine,
				exec: async () => {
					throw new HostRequestError(
						429,
						'capacity reached',
						false,
						'guest_operation_capacity_reached'
					);
				}
			})
		);

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(await response.json()).toMatchObject({
			title: 'guest_operation_capacity_reached',
			retry_after_seconds: 1
		});
		expect(
			database.calls.map((values) => values[7]).filter((value) => value !== 'api_key')
		).toEqual(['requested', 'failed']);
		expect(JSON.stringify(database.calls)).toContain('guest_operation_capacity_reached');
	});

	it('returns and audits managed guest-agent absence without exposing serial recovery', async () => {
		const database = new AuditDatabase();
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/exec`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ command: 'true', timeout_seconds: 5 })
			}),
			services(database, {
				get: async () => machine,
				exec: async () => {
					throw new HostRequestError(503, 'unavailable', false, 'guest_agent_unavailable');
				}
			})
		);

		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(await response.json()).toMatchObject({
			title: 'guest_agent_unavailable',
			retry_after_seconds: 1
		});
		expect(JSON.stringify(database.calls)).toContain('guest_agent_unavailable');
	});

	it('returns an honest non-retryable warning when exec succeeded but terminal audit failed', async () => {
		const database = new AuditDatabase(false, 3);
		const exec = vi.fn(async () => ({
			stdout: 'completed once',
			stderr: '',
			exit_code: 0,
			timed_out: false,
			duration_ms: 3
		}));
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/exec`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ command: 'touch /tmp/only-once', timeout_seconds: 5 })
			}),
			services(database, { get: async () => machine, exec })
		);

		expect(exec).toHaveBeenCalledOnce();
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			title: 'operation_result_pending',
			operation_may_have_completed: true
		});
	});

	it('requires an idempotency key for extend', async () => {
		const extend = vi.fn(async (...args: Parameters<MachineService['extend']>) => {
			expect(args[4]).toBe('');
			throw new InvalidMachineRequest('A valid Idempotency-Key header is required.');
		});
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/extend`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ ttl_seconds: 300 })
			}),
			services(new AuditDatabase(), { get: async () => machine, extend })
		);

		expect(response.status).toBe(400);
		expect(extend).toHaveBeenCalledOnce();
	});

	it('marks a replayed extend response without exposing the key in audit data', async () => {
		const database = new AuditDatabase();
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/extend`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json',
					'idempotency-key': 'extend-route-secret-key'
				},
				body: JSON.stringify({ ttl_seconds: 300 })
			}),
			services(database, {
				get: async () => machine,
				extend: async () => ({ machine, replayed: true, applied: true })
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('idempotency-replayed')).toBe('true');
		expect(JSON.stringify(database.calls)).not.toContain('extend-route-secret-key');
		expect(
			database.calls.map((values) => values[7]).filter((value) => value !== 'api_key')
		).toEqual(['requested', 'succeeded']);
	});

	it('returns typed recovery data and defers a terminal audit for an accepted fork', async () => {
		const database = new AuditDatabase();
		const children = [
			{ ...machine, id: 'm_fork_child_one', parentId: machine.id },
			{ ...machine, id: 'm_fork_child_two', parentId: machine.id }
		];
		const fork = vi.fn(async (...args: Parameters<MachineService['fork']>) => ({
			operationId: '11111111-1111-4111-8111-111111111111',
			auditOperationId: args[5]!,
			idempotencyKey: 'fork-route-secret-key',
			machines: children,
			replayed: false,
			pending: true,
			cleanupPending: true
		}));
		const response = await router().handle(
			new Request(`https://api.example.com/v1/machines/${machine.id}/fork`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer bc_test_route_key',
					'content-type': 'application/json',
					'idempotency-key': 'fork-route-secret-key'
				},
				body: JSON.stringify({ count: 2 })
			}),
			services(database, { get: async () => machine, fork })
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			requested: 2,
			operation: {
				id: '11111111-1111-4111-8111-111111111111',
				state: 'cleanup_pending',
				idempotency_key: 'fork-route-secret-key',
				source_machine_id: machine.id,
				requested: 2
			},
			machines: [{ id: 'm_fork_child_one', parent_id: machine.id }, { id: 'm_fork_child_two' }]
		});
		expect(fork).toHaveBeenCalledWith(
			machine.id,
			machine.organizationId,
			machine.projectId,
			2,
			'fork-route-secret-key',
			expect.any(String)
		);
		expect(
			database.calls.map((values) => values[7]).filter((value) => value !== 'api_key')
		).toEqual(['requested']);
		const serializedAudit = JSON.stringify(database.calls);
		expect(serializedAudit).not.toContain('fork-route-secret-key');
	});
});
