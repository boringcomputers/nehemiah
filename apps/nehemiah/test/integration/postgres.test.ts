import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	CreateOnHostRequest,
	ForkOnHostChild,
	HostClient,
	HostExecResult,
	HostMachine
} from '../../src/clients/nehemiahd.js';
import { HostForkContractError } from '../../src/clients/nehemiahd.js';
import { UsageLedger } from '../../src/billing/usage.js';
import { Database } from '../../src/db/client.js';
import { HostCredentialCipher } from '../../src/domain/host-credentials.js';
import { HostService } from '../../src/domain/hosts.js';
import { MachineService, PostgresMachineRepository } from '../../src/domain/machines.js';
import { PostgresVolumeRepository, VolumeQuotaExceeded } from '../../src/domain/volumes.js';
import { MachineReconciler } from '../../src/jobs/reconcile-machines.js';
import { reapExpiredMachines } from '../../src/jobs/reap-expired-machines.js';
import { QuotaExceeded, Scheduler } from '../../src/scheduler/scheduler.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

class NoopHost implements HostClient {
	async create(): Promise<HostMachine> {
		throw new Error('not expected');
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
	async extend(): Promise<HostMachine> {
		throw new Error('not expected');
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('not expected');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('not expected');
	}
}

class ObservingHost implements HostClient {
	readonly observations = new Map<string, HostMachine>();
	readonly getCalls: string[] = [];
	readonly destroyCalls: string[] = [];

	async create(): Promise<HostMachine> {
		throw new Error('unexpected host create');
	}
	async get(_address: string, hostMachineId: string): Promise<HostMachine | undefined> {
		this.getCalls.push(hostMachineId);
		const observed = this.observations.get(hostMachineId);
		return observed
			? { network_policy: { mode: 'off', hostnames: [], cidrs: [] }, ...observed }
			: undefined;
	}
	async destroy(_address: string, hostMachineId: string): Promise<void> {
		this.destroyCalls.push(hostMachineId);
		this.observations.delete(hostMachineId);
	}
	async extend(): Promise<HostMachine> {
		throw new Error('unexpected host extend');
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('unexpected host fork');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('unexpected host exec');
	}
}

class CreatingHost implements HostClient {
	readonly createCalls: CreateOnHostRequest[] = [];

	async create(_address: string, request: CreateOnHostRequest): Promise<HostMachine> {
		this.createCalls.push(request);
		return {
			id: `local-${request.idempotencyKey}`,
			status: 'running',
			ready: true,
			lease_id: request.leaseId,
			metadata: request.metadata,
			resources: {
				vcpus: request.resources.vcpus,
				memory_mb: request.resources.memoryMb,
				disk_mb: request.resources.diskMb
			},
			network_policy: request.networkPolicy
		};
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
	async extend(): Promise<HostMachine> {
		throw new Error('unexpected host extend');
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('unexpected host fork');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('unexpected host exec');
	}
}

class ExtendingHost implements HostClient {
	readonly targets: Date[] = [];

	async create(): Promise<HostMachine> {
		throw new Error('unexpected host create');
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
	async extend(
		_address: string,
		hostMachineId: string,
		leaseId: string,
		_idempotencyKey: string,
		targetExpiresAt: Date
	): Promise<HostMachine> {
		this.targets.push(targetExpiresAt);
		return {
			id: hostMachineId,
			status: 'running',
			ready: true,
			lease_id: leaseId,
			expires_at: targetExpiresAt.toISOString()
		};
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('unexpected host fork');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('unexpected host exec');
	}
}

class ForkingHost implements HostClient {
	readonly forkCalls: Array<{
		key: string;
		children: ReadonlyArray<ForkOnHostChild>;
	}> = [];
	readonly destroyCalls: Array<{ id: string; leaseId: string }> = [];
	partialUntilCall = 0;
	terminalOnCall = 0;
	malformedOnCall = 0;

	async create(): Promise<HostMachine> {
		throw new Error('unexpected host create');
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(_address: string, id: string, leaseId: string): Promise<void> {
		this.destroyCalls.push({ id, leaseId });
	}
	async extend(): Promise<HostMachine> {
		throw new Error('unexpected host extend');
	}
	async fork(
		_address: string,
		_sourceHostMachineId: string,
		_sourceLeaseId: string,
		key: string,
		children: ReadonlyArray<ForkOnHostChild>
	): Promise<ReadonlyArray<HostMachine>> {
		this.forkCalls.push({ key, children });
		const call = this.forkCalls.length;
		const machines = children.map((child, index) => {
			const terminal = call === this.terminalOnCall && index === children.length - 1;
			const partial = call <= this.partialUntilCall && index === children.length - 1;
			return {
				id: `local-fork-${child.metadata.public_machine_id}`,
				status: terminal ? 'failed' : partial ? 'starting' : 'running',
				ready: !terminal && !partial,
				lease_id: child.leaseId,
				metadata: child.metadata,
				expires_at: child.expiresAt.toISOString(),
				resources: {
					vcpus: child.resources.vcpus,
					memory_mb: child.resources.memoryMb,
					disk_mb: child.resources.diskMb
				},
				network_policy: child.networkPolicy
			};
		});
		if (call === this.malformedOnCall) {
			throw new HostForkContractError('malformed fork batch', machines.slice(0, 1));
		}
		return machines;
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('unexpected host exec');
	}
}

class SelectiveUsageLedger extends UsageLedger {
	constructor(
		database: Database,
		private readonly failingMachines: ReadonlySet<string>
	) {
		super(database);
	}

	override async recordMachineRuntime(
		input: Parameters<UsageLedger['recordMachineRuntime']>[0]
	): Promise<void> {
		if (this.failingMachines.has(input.machineId)) throw new Error('poison usage interval');
	}
}

const seedFleet = async (database: Database, label: string) => {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const hostId = randomUUID();
	const regionId = `${label}-${randomUUID()}`;
	const addressSuffix = randomUUID().replaceAll('-', '').slice(0, 4);
	await database.transaction(async (client) => {
		await client.query(
			`INSERT INTO regions (id, provider, display_name) VALUES ($1, 'integration', $2)`,
			[regionId, label]
		);
		await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
			organizationId,
			label,
			`${label}-${organizationId}`
		]);
		await client.query(
			`INSERT INTO projects
			 (id, organization_id, name, slug, max_machines, max_vcpus, max_memory_mb, max_storage_mb)
			 VALUES ($1, $2, $3, $4, 1000, 1000, 1048576, 10485760)`,
			[projectId, organizationId, label, `${label}-${projectId}`]
		);
		await client.query(
			`INSERT INTO hosts
			 (id, provider_id, region_id, address, architecture, state, credential_hash,
			  control_credential_ciphertext, gateway_credential_ciphertext,
			  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
			  reported_available_vcpus, reported_available_memory_mb, reported_available_disk_mb,
			  runtime_cohort_id, runtime_contract_version, runtime_arch,
			  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
			  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
			 VALUES ($1, $2, $3, $4, 'x86_64', 'ready', 'test', 'test', 'test',
			         1000, 1048576, 10485760, now(), 1000, 1048576, 10485760,
			         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
			         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
			[hostId, `${label}-${hostId}`, regionId, `fd00:6e65:6865:${addressSuffix}::1`]
		);
	});
	return { organizationId, projectId, hostId, regionId };
};

const seedForkSource = async (database: Database, label: string) => {
	const fleet = await seedFleet(database, label);
	const machineId = `m_fork_source_${randomUUID().replaceAll('-', '')}`;
	const leaseId = randomUUID();
	const hostMachineId = `local-source-${randomUUID()}`;
	await database.transaction(async (client) => {
		await client.query(
			`UPDATE hosts SET reserved_vcpus = 2, reserved_memory_mb = 2048,
			 reserved_disk_mb = 10240 WHERE id = $1`,
			[fleet.hostId]
		);
		await client.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
			  idempotency_key, idempotency_request_hash, state, region_id, architecture,
			  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
			  ready, placed_at, started_at, ready_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, 'x86_64',
			         'python', 900, 2, 2048, 10240, true, now(), now(), now(),
			         now() + interval '15 minutes')`,
			[
				machineId,
				fleet.organizationId,
				fleet.projectId,
				fleet.hostId,
				hostMachineId,
				leaseId,
				`source-${randomUUID()}`,
				'f'.repeat(64),
				fleet.regionId
			]
		);
	});
	return { ...fleet, machineId, leaseId, hostMachineId };
};

databaseDescribe('PostgreSQL lifecycle integration', () => {
	let database: Database;

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.ping();
	});

	afterAll(async () => {
		await database.close();
	});

	it('executes only one side effect for concurrent same-key create requests', async () => {
		const fleet = await seedFleet(database, 'create-claim');
		const host = new CreatingHost();
		const machines = new MachineService(
			new PostgresMachineRepository(database),
			new Scheduler(database),
			host
		);
		const create = {
			organizationId: fleet.organizationId,
			projectId: fleet.projectId,
			region: fleet.regionId,
			architecture: 'x86_64' as const,
			resources: { vcpus: 1, memoryMb: 512, diskMb: 5120 },
			template: 'python',
			networkPolicy: { mode: 'off' as const, hostnames: [], cidrs: [] },
			ttlSeconds: 900,
			idempotencyKey: `same-${randomUUID()}`
		};

		const results = await Promise.all([machines.create(create), machines.create(create)]);

		expect(new Set(results.map(({ machine }) => machine.id)).size).toBe(1);
		expect(results.some(({ replayed }) => replayed)).toBe(true);
		expect(host.createCalls).toHaveLength(1);
		expect(host.createCalls[0]?.networkPolicy).toEqual({ mode: 'off', hostnames: [], cidrs: [] });
		expect(results[0]?.machine.networkPolicy).toEqual(host.createCalls[0]?.networkPolicy);
		const accounting = await database.query<{ reserved_vcpus: number; active: string }>(
			`SELECT h.reserved_vcpus,
			        count(m.*) FILTER (WHERE m.state NOT IN ('stopped', 'failed', 'lost')) AS active
			 FROM hosts h LEFT JOIN machines m ON m.host_id = h.id
			 WHERE h.id = $1 GROUP BY h.reserved_vcpus`,
			[fleet.hostId]
		);
		expect(accounting.rows[0]).toEqual({ reserved_vcpus: 1, active: '1' });
		await machines.destroy(results[0]!.machine.id, fleet.organizationId, fleet.projectId);
	});

	it('enforces independent project machine-disk and volume-storage quotas concurrently', async () => {
		const fleet = await seedFleet(database, 'project-disk-volume');
		const machineId = `m_quota_${randomUUID().replaceAll('-', '')}`;
		const rejectedMachineId = `m_quota_${randomUUID().replaceAll('-', '')}`;
		await database.transaction(async (client) => {
			await client.query(`UPDATE projects SET max_disk_mb = 10, max_storage_mb = 1 WHERE id = $1`, [
				fleet.projectId
			]);
			for (const [id, diskMb] of [
				[machineId, 10],
				[rejectedMachineId, 1]
			] as const) {
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, lease_id, idempotency_key,
					  idempotency_request_hash, state, region_id, architecture, template_name,
					  requested_ttl_seconds, vcpus, memory_mb, disk_mb, expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, 'x86_64', 'python',
					         3600, 1, 512, $8, now() + interval '1 hour')`,
					[
						id,
						fleet.organizationId,
						fleet.projectId,
						randomUUID(),
						`quota-${id}`,
						'a'.repeat(64),
						fleet.regionId,
						diskMb
					]
				);
			}
		});

		const scheduler = new Scheduler(database);
		const volumes = new PostgresVolumeRepository(database);
		const now = new Date();
		const volumeId = `vol_${randomUUID().replaceAll('-', '')}`;
		const [reservation, admitted] = await Promise.all([
			scheduler.reserve({
				organizationId: fleet.organizationId,
				projectId: fleet.projectId,
				region: fleet.regionId,
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 10 },
				machineId
			}),
			volumes.admitCreate(
				{
					id: volumeId,
					organizationId: fleet.organizationId,
					projectId: fleet.projectId,
					objectPrefix: `organizations/${fleet.organizationId}/projects/${fleet.projectId}/volumes/${volumeId}/`,
					sizeLimitBytes: 1_048_576,
					observedSizeBytes: 0,
					createdAt: now,
					expiresAt: new Date(now.getTime() + 3_600_000)
				},
				`quota-volume-${randomUUID()}`,
				'b'.repeat(64)
			)
		]);

		expect(reservation.hostId).toBe(fleet.hostId);
		expect(admitted.volume.id).toBe(volumeId);
		const usage = await database.query<{
			machine_disk_mb: string;
			volume_bytes: string;
		}>(
			`SELECT
			   (SELECT COALESCE(sum(disk_mb), 0)::text FROM machines
			     WHERE project_id = $1 AND state = 'starting') AS machine_disk_mb,
			   (SELECT COALESCE(sum(size_limit_bytes), 0)::text FROM volumes
			     WHERE project_id = $1 AND deleted_at IS NULL) AS volume_bytes`,
			[fleet.projectId]
		);
		expect(usage.rows[0]).toEqual({ machine_disk_mb: '10', volume_bytes: '1048576' });

		await expect(
			scheduler.reserve({
				organizationId: fleet.organizationId,
				projectId: fleet.projectId,
				region: fleet.regionId,
				architecture: 'x86_64',
				resources: { vcpus: 1, memoryMb: 512, diskMb: 1 },
				machineId: rejectedMachineId
			})
		).rejects.toBeInstanceOf(QuotaExceeded);
		await expect(
			volumes.admitCreate(
				{
					id: `vol_${randomUUID().replaceAll('-', '')}`,
					organizationId: fleet.organizationId,
					projectId: fleet.projectId,
					objectPrefix: `organizations/${fleet.organizationId}/projects/${fleet.projectId}/volumes/rejected/`,
					sizeLimitBytes: 1,
					observedSizeBytes: 0,
					createdAt: now,
					expiresAt: new Date(now.getTime() + 3_600_000)
				},
				`quota-volume-rejected-${randomUUID()}`,
				'c'.repeat(64)
			)
		).rejects.toBeInstanceOf(VolumeQuotaExceeded);
		await database.transaction(async (client) => {
			await client.query('DELETE FROM volumes WHERE id = $1', [volumeId]);
			await client.query(
				`UPDATE machines SET state = 'failed', stopped_at = now(),
				 reservation_released_at = now(), usage_finalized_at = now()
				 WHERE id = ANY($1::text[])`,
				[[machineId, rejectedMachineId]]
			);
			await client.query(
				`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0,
				 reserved_disk_mb = 0 WHERE id = $1`,
				[fleet.hostId]
			);
		});
	});

	it('persists and replays one database-clock extend target', async () => {
		const fleet = await seedFleet(database, 'extend-operation');
		const machineId = `m_extend_${randomUUID().replaceAll('-', '')}`;
		const leaseId = randomUUID();
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
			  idempotency_key, idempotency_request_hash, state, region_id, architecture,
			  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
			  ready, placed_at, started_at, ready_at, expires_at)
			 VALUES ($1, $2, $3, $4, 'local-extend', $5, 'extend-create', $6, 'running', $7,
			         'x86_64', 'python', 900, 1, 512, 5120, true, now(), now(), now(),
			         now() + interval '1 minute')`,
			[
				machineId,
				fleet.organizationId,
				fleet.projectId,
				fleet.hostId,
				leaseId,
				'a'.repeat(64),
				fleet.regionId
			]
		);
		const host = new ExtendingHost();
		const machines = new MachineService(
			new PostgresMachineRepository(database),
			new Scheduler(database),
			host
		);
		const key = `extend-${randomUUID()}`;

		const first = await machines.extend(machineId, fleet.organizationId, fleet.projectId, 300, key);
		const replay = await machines.extend(
			machineId,
			fleet.organizationId,
			fleet.projectId,
			300,
			key
		);

		expect(first.applied).toBe(true);
		expect(replay.replayed).toBe(true);
		expect(replay.machine?.expiresAt).toEqual(first.machine?.expiresAt);
		expect(host.targets).toHaveLength(1);
		const operations = await database.query<{
			target_expires_at: Date;
			result_expires_at: Date;
			completed: boolean;
		}>(
			`SELECT target_expires_at, result_expires_at, completed_at IS NOT NULL AS completed
			 FROM machine_extend_operations WHERE machine_id = $1`,
			[machineId]
		);
		expect(operations.rows).toEqual([
			{
				target_expires_at: host.targets[0],
				result_expires_at: host.targets[0],
				completed: true
			}
		]);
		await expect(
			database.query(
				`UPDATE machine_extend_operations SET target_expires_at = target_expires_at + interval '1 second'
				 WHERE machine_id = $1`,
				[machineId]
			)
		).rejects.toThrow('machine extend operation identity is immutable');
		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE id = $1`,
			[machineId]
		);
	});

	it('atomically allocates one stable fork batch under concurrent same-key requests', async () => {
		const fleet = await seedForkSource(database, 'fork-concurrent');
		const inheritedPolicy = {
			mode: 'off',
			hostnames: [],
			cidrs: []
		};
		const host = new ForkingHost();
		const repository = new PostgresMachineRepository(database);
		const service = new MachineService(repository, new Scheduler(database), host);
		const key = `fork-${randomUUID()}`;

		const concurrent = await Promise.all([
			service.fork(fleet.machineId, fleet.organizationId, fleet.projectId, 3, key),
			service.fork(fleet.machineId, fleet.organizationId, fleet.projectId, 3, key)
		]);
		const childIDs = concurrent[0]!.machines.map(({ id }) => id);
		expect(concurrent[1]!.machines.map(({ id }) => id)).toEqual(childIDs);
		expect(new Set(childIDs).size).toBe(3);
		expect(concurrent.every(({ pending }) => !pending)).toBe(true);
		expect(concurrent.some(({ replayed }) => replayed)).toBe(true);
		const replay = await service.fork(
			fleet.machineId,
			fleet.organizationId,
			fleet.projectId,
			3,
			key
		);
		expect(replay.machines.map(({ id }) => id)).toEqual(childIDs);
		await expect(
			service.fork(fleet.machineId, fleet.organizationId, fleet.projectId, 2, key)
		).rejects.toMatchObject({ code: 'idempotency_conflict' });

		const durable = await database.query<{
			operations: string;
			children: string;
			leases: string;
			reserved_vcpus: number;
		}>(
			`SELECT count(DISTINCT operation.id) AS operations,
			        count(child.*) AS children, count(DISTINCT child.lease_id) AS leases,
			        max(host.reserved_vcpus) AS reserved_vcpus
			 FROM machine_fork_operations operation
			 JOIN machine_fork_children child ON child.operation_id = operation.id
			 JOIN hosts host ON host.id = operation.source_host_id
			 WHERE operation.source_machine_id = $1`,
			[fleet.machineId]
		);
		expect(durable.rows[0]).toEqual({
			operations: '1',
			children: '3',
			leases: '3',
			reserved_vcpus: 8
		});
		const policies = await database.query<{ network_policy: unknown }>(
			`SELECT network_policy FROM machines
			 WHERE parent_machine_id = $1 ORDER BY id`,
			[fleet.machineId]
		);
		expect(policies.rows).toHaveLength(3);
		for (const { network_policy } of policies.rows) {
			expect(network_policy).toEqual(inheritedPolicy);
		}

		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[fleet.hostId]
		);
	});

	it('applies organization quota and delinquency admission to the whole fork batch', async () => {
		const fleet = await seedForkSource(database, 'fork-org-admission');
		const host = new ForkingHost();
		const service = new MachineService(
			new PostgresMachineRepository(database),
			new Scheduler(database),
			host
		);

		// The source already consumes one machine and two vCPUs. A two-child
		// batch must be rejected as one unit even though the project is roomy.
		await database.query(
			`UPDATE organizations
			 SET max_machines = 2, max_vcpus = 100, max_memory_mb = 1048576,
			     max_disk_mb = 10485760
			 WHERE id = $1`,
			[fleet.organizationId]
		);
		await expect(
			service.fork(
				fleet.machineId,
				fleet.organizationId,
				fleet.projectId,
				2,
				`fork-org-quota-${randomUUID()}`
			)
		).rejects.toMatchObject({ code: 'quota_exceeded' });

		await database.transaction(async (client) => {
			await client.query(
				`UPDATE organizations
				 SET max_machines = 1000, max_vcpus = 1000, max_memory_mb = 1048576,
				     max_disk_mb = 10485760
				 WHERE id = $1`,
				[fleet.organizationId]
			);
			await client.query(
				`INSERT INTO billing_accounts (organization_id, delinquent_at)
				 VALUES ($1, now())`,
				[fleet.organizationId]
			);
		});
		await expect(
			service.fork(
				fleet.machineId,
				fleet.organizationId,
				fleet.projectId,
				1,
				`fork-delinquent-${randomUUID()}`
			)
		).rejects.toMatchObject({ code: 'billing_delinquent' });

		expect(host.forkCalls).toHaveLength(0);
		const durable = await database.query<{ operations: string; reserved_vcpus: number }>(
			`SELECT
			   (SELECT count(*) FROM machine_fork_operations
			     WHERE source_machine_id = $1) AS operations,
			   reserved_vcpus
			 FROM hosts WHERE id = $2`,
			[fleet.machineId, fleet.hostId]
		);
		expect(durable.rows[0]).toEqual({ operations: '0', reserved_vcpus: 2 });
	});

	it('hides a partially ready fork batch and reconciles it without new children', async () => {
		const fleet = await seedForkSource(database, 'fork-partial');
		const host = new ForkingHost();
		host.partialUntilCall = 1;
		const repository = new PostgresMachineRepository(database);
		const service = new MachineService(repository, new Scheduler(database), host);
		const idempotencyKey = `fork-${randomUUID()}`;
		const pending = await service.fork(
			fleet.machineId,
			fleet.organizationId,
			fleet.projectId,
			2,
			idempotencyKey
		);

		expect(pending.pending).toBe(true);
		expect(pending.machines).toHaveLength(2);
		expect(
			await repository.find(pending.machines[0]!.id, fleet.organizationId, fleet.projectId)
		).toBeUndefined();
		expect(
			(await repository.list(fleet.organizationId, fleet.projectId)).map(({ id }) => id)
		).toEqual([fleet.machineId]);

		await database.query(
			`UPDATE machines SET reconcile_after = now() + interval '1 hour'
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
		await new MachineReconciler(database, host).run();
		const visible = await repository.list(fleet.organizationId, fleet.projectId);
		expect(visible.map(({ id }) => id).sort()).toEqual(
			[fleet.machineId, ...pending.machines.map(({ id }) => id)].sort()
		);
		expect(
			visible.filter(({ parentId }) => parentId === fleet.machineId).every(({ ready }) => ready)
		).toBe(true);
		expect(host.forkCalls.filter(({ key }) => key === idempotencyKey)).toHaveLength(2);
		const rows = await database.query<{ children: string; state: string }>(
			`SELECT count(child.*) AS children, max(operation.state::text) AS state
			 FROM machine_fork_operations operation
			 JOIN machine_fork_children child ON child.operation_id = operation.id
			 WHERE operation.source_machine_id = $1`,
			[fleet.machineId]
		);
		expect(rows.rows[0]).toEqual({ children: '2', state: 'succeeded' });

		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[fleet.hostId]
		);
	});

	it('retains hidden children and host capacity until malformed-batch cleanup is confirmed', async () => {
		const fleet = await seedForkSource(database, 'fork-cleanup-pending');
		const host = new ForkingHost();
		host.malformedOnCall = 1;
		const repository = new PostgresMachineRepository(database);
		const service = new MachineService(repository, new Scheduler(database), host);
		const pending = await service.fork(
			fleet.machineId,
			fleet.organizationId,
			fleet.projectId,
			2,
			`fork-${randomUUID()}`
		);

		expect(pending).toMatchObject({ pending: true, cleanupPending: true });
		expect(host.destroyCalls).toHaveLength(1);
		const beforeConfirmation = await database.query<{
			state: string;
			cleanup_requested: boolean;
			reserved_vcpus: number;
			released_children: string;
		}>(
			`SELECT operation.state::text AS state,
			        operation.cleanup_requested_at IS NOT NULL AS cleanup_requested,
			        host.reserved_vcpus,
			        count(machine.*) FILTER (WHERE machine.reservation_released_at IS NOT NULL)
			          AS released_children
			 FROM machine_fork_operations operation
			 JOIN hosts host ON host.id = operation.source_host_id
			 JOIN machines machine ON machine.fork_operation_id = operation.id
			 WHERE operation.id = $1
			 GROUP BY operation.state, operation.cleanup_requested_at, host.reserved_vcpus`,
			[pending.operationId]
		);
		expect(beforeConfirmation.rows[0]).toEqual({
			state: 'pending',
			cleanup_requested: true,
			reserved_vcpus: 6,
			released_children: '0'
		});
		expect(await repository.list(fleet.organizationId, fleet.projectId)).toHaveLength(1);

		const cleanup = await repository.requestForkCleanup(
			pending.operationId,
			502,
			'fork_batch_failed',
			'cleanup confirmation'
		);
		expect(cleanup.cleanupClaimToken).toBeDefined();
		await repository.completeForkCleanup(pending.operationId, cleanup.cleanupClaimToken!);
		const afterConfirmation = await database.query<{
			state: string;
			reserved_vcpus: number;
			terminal_audits: string;
		}>(
			`SELECT operation.state::text AS state, host.reserved_vcpus,
			        count(DISTINCT audit.id) FILTER (
			          WHERE audit.outcome IN ('succeeded', 'failed')
			        ) AS terminal_audits
			 FROM machine_fork_operations operation
			 JOIN hosts host ON host.id = operation.source_host_id
			 LEFT JOIN audit_events audit ON audit.operation_id = operation.audit_operation_id
			 WHERE operation.id = $1
			 GROUP BY operation.state, host.reserved_vcpus`,
			[pending.operationId]
		);
		expect(afterConfirmation.rows[0]).toEqual({
			state: 'failed',
			reserved_vcpus: 2,
			terminal_audits: '1'
		});

		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[fleet.hostId]
		);
	});

	it('cleans every terminal fork child and releases the batch reservation exactly once', async () => {
		const fleet = await seedForkSource(database, 'fork-cleanup');
		const host = new ForkingHost();
		host.terminalOnCall = 1;
		const repository = new PostgresMachineRepository(database);
		const service = new MachineService(repository, new Scheduler(database), host);
		const key = `fork-${randomUUID()}`;

		await expect(
			service.fork(fleet.machineId, fleet.organizationId, fleet.projectId, 2, key)
		).rejects.toMatchObject({ code: 'fork_batch_failed', status: 502 });
		expect(host.destroyCalls).toHaveLength(2);
		await expect(
			service.fork(fleet.machineId, fleet.organizationId, fleet.projectId, 2, key)
		).rejects.toMatchObject({ code: 'fork_batch_failed', status: 502 });
		expect(host.destroyCalls).toHaveLength(2);

		const operation = await database.query<{ id: string }>(
			`SELECT id FROM machine_fork_operations WHERE source_machine_id = $1`,
			[fleet.machineId]
		);
		await repository.failFork(
			operation.rows[0]!.id,
			502,
			'fork_batch_failed',
			'should remain the original terminal result'
		);
		const accounting = await database.query<{
			state: string;
			failed_children: string;
			released_children: string;
			reserved_vcpus: number;
		}>(
			`SELECT max(operation.state::text) AS state,
			        count(machine.*) FILTER (WHERE machine.state = 'failed') AS failed_children,
			        count(machine.*) FILTER (WHERE machine.reservation_released_at IS NOT NULL)
			          AS released_children,
			        max(host.reserved_vcpus) AS reserved_vcpus
			 FROM machine_fork_operations operation
			 JOIN machines machine ON machine.fork_operation_id = operation.id
			 JOIN hosts host ON host.id = operation.source_host_id
			 WHERE operation.source_machine_id = $1`,
			[fleet.machineId]
		);
		expect(accounting.rows[0]).toEqual({
			state: 'failed',
			failed_children: '2',
			released_children: '2',
			reserved_vcpus: 2
		});
		const terminalAudit = await database.query<{ outcome: string; events: string }>(
			`SELECT max(audit.outcome) AS outcome, count(*) AS events
			 FROM audit_events audit
			 JOIN machine_fork_operations operation
			   ON operation.audit_operation_id = audit.operation_id
			 WHERE operation.id = $1 AND audit.outcome IN ('succeeded', 'failed')`,
			[operation.rows[0]!.id]
		);
		expect(terminalAudit.rows[0]).toEqual({ outcome: 'failed', events: '1' });
		expect(await repository.list(fleet.organizationId, fleet.projectId)).toHaveLength(1);

		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[fleet.hostId]
		);
	});

	it('does not reap an old projection while a durable extend target is still live', async () => {
		const fleet = await seedFleet(database, 'extend-reaper');
		const machineId = `m_extend_reaper_${randomUUID().replaceAll('-', '')}`;
		const expiredMachineId = `m_extend_elapsed_${randomUUID().replaceAll('-', '')}`;
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
			  state, region_id, architecture, template_name, requested_ttl_seconds,
			  vcpus, memory_mb, disk_mb, expires_at)
			 VALUES ($1, $2, $3, 'extend-reaper-create', $4, 'requested', $5, 'x86_64',
			         'python', 900, 1, 512, 5120, now() - interval '1 minute')`,
			[machineId, fleet.organizationId, fleet.projectId, 'b'.repeat(64), fleet.regionId]
		);
		await database.query(
			`INSERT INTO machine_extend_operations
			 (organization_id, project_id, machine_id, idempotency_key, request_hash,
			  target_expires_at)
			 VALUES ($1, $2, $3, 'extend-reaper', $4, now() + interval '5 minutes')`,
			[fleet.organizationId, fleet.projectId, machineId, 'c'.repeat(64)]
		);
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
			  state, region_id, architecture, template_name, requested_ttl_seconds,
			  vcpus, memory_mb, disk_mb, expires_at)
			 VALUES ($1, $2, $3, 'extend-elapsed-create', $4, 'requested', $5, 'x86_64',
			         'python', 900, 1, 512, 5120, now() - interval '2 minutes')`,
			[expiredMachineId, fleet.organizationId, fleet.projectId, 'd'.repeat(64), fleet.regionId]
		);
		await database.query(
			`INSERT INTO machine_extend_operations
			 (organization_id, project_id, machine_id, idempotency_key, request_hash,
			  target_expires_at)
			 VALUES ($1, $2, $3, 'extend-elapsed', $4, now() - interval '1 minute')`,
			[fleet.organizationId, fleet.projectId, expiredMachineId, 'e'.repeat(64)]
		);
		const destroyed: string[] = [];
		const service = {
			destroy: async (id: string) => {
				destroyed.push(id);
				return true;
			}
		} as unknown as MachineService;

		await reapExpiredMachines(database, service);
		expect(destroyed).not.toContain(machineId);
		expect(destroyed).toContain(expiredMachineId);
		await database.query(
			`UPDATE machines SET state = 'stopped', stopped_at = now(),
			 reservation_released_at = now(), usage_finalized_at = now()
			 WHERE id = ANY($1::text[])`,
			[[machineId, expiredMachineId]]
		);
	});

	it('admits exactly one of two concurrent creates at a max-one project quota', async () => {
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const hostId = randomUUID();
		const regionId = `integration-${randomUUID()}`;
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO regions (id, provider, display_name) VALUES ($1, 'integration', 'Integration')`,
				[regionId]
			);
			await client.query(
				`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Quota test', $2)`,
				[organizationId, `quota-${organizationId}`]
			);
			await client.query(
				`INSERT INTO projects
				 (id, organization_id, name, slug, max_machines, max_vcpus, max_memory_mb, max_storage_mb)
				 VALUES ($1, $2, 'Quota project', $3, 1, 1, 512, 5120)`,
				[projectId, organizationId, `quota-${projectId}`]
			);
			await client.query(
				`INSERT INTO hosts
			  (id, provider_id, region_id, address, architecture, state, credential_hash,
			   control_credential_ciphertext, gateway_credential_ciphertext,
			   total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
			   reported_available_vcpus, reported_available_memory_mb, reported_available_disk_mb,
			   runtime_cohort_id, runtime_contract_version, runtime_arch,
			   runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
			   runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
			 VALUES ($1, $2, $3, $4, 'x86_64', 'ready', 'test', 'test', 'test',
			         4, 4096, 20480, now(), 4, 4096, 20480,
			         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
			         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
				[hostId, `provider-${hostId}`, regionId, `10.64.1.${Math.floor(Math.random() * 200) + 1}`]
			);
		});
		for (const suffix of ['one', 'two']) {
			await database.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
				  region_id, architecture, template_name, requested_ttl_seconds,
				  vcpus, memory_mb, disk_mb, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'x86_64', 'python', 900,
				         1, 512, 5120, now() + interval '15 minutes')`,
				[
					`m_integration_${suffix}_${randomUUID().replaceAll('-', '')}`,
					organizationId,
					projectId,
					`create-${suffix}`,
					(suffix === 'one' ? 'a' : 'b').repeat(64),
					regionId
				]
			);
		}
		const rows = await database.query<{ id: string }>(
			`SELECT id FROM machines WHERE project_id = $1 ORDER BY id`,
			[projectId]
		);
		const scheduler = new Scheduler(database);
		const outcomes = await Promise.allSettled(
			rows.rows.map(({ id }) =>
				scheduler.reserve({
					organizationId,
					projectId,
					region: regionId,
					architecture: 'x86_64',
					resources: { vcpus: 1, memoryMb: 512, diskMb: 5120 },
					machineId: id
				})
			)
		);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
		expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(QuotaExceeded);
		const result = await database.query<{ starting: string; reserved_vcpus: number }>(
			`SELECT count(*) FILTER (WHERE m.state = 'starting') AS starting, h.reserved_vcpus
			 FROM machines m JOIN hosts h ON h.id = $2 WHERE m.project_id = $1
			 GROUP BY h.reserved_vcpus`,
			[projectId, hostId]
		);
		expect(Number(result.rows[0]?.starting)).toBe(1);
		expect(result.rows[0]?.reserved_vcpus).toBe(1);
		await database.query(
			`UPDATE machines SET state = 'failed', stopped_at = now(), reservation_released_at = now()
			 WHERE project_id = $1`,
			[projectId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[hostId]
		);
	});

	it('enforces one organization quota across concurrent sibling-project creates', async () => {
		const organizationId = randomUUID();
		const projectIds = [randomUUID(), randomUUID()];
		const hostId = randomUUID();
		const regionId = `org-quota-${randomUUID()}`;
		const addressSuffix = randomUUID().replaceAll('-', '').slice(0, 4);
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO regions (id, provider, display_name)
				 VALUES ($1, 'integration', 'Organization quota integration')`,
				[regionId]
			);
			await client.query(
				`INSERT INTO organizations
				 (id, name, slug, max_machines, max_vcpus, max_memory_mb, max_disk_mb)
				 VALUES ($1, 'Organization quota', $2, 1, 1, 512, 5120)`,
				[organizationId, `org-quota-${organizationId}`]
			);
			for (const projectId of projectIds) {
				await client.query(
					`INSERT INTO projects
					 (id, organization_id, name, slug, max_machines, max_vcpus,
					  max_memory_mb, max_storage_mb)
					 VALUES ($1, $2, 'Sibling project', $3, 10, 10, 10240, 102400)`,
					[projectId, organizationId, `sibling-${projectId}`]
				);
			}
			await client.query(
				`INSERT INTO hosts
				 (id, provider_id, region_id, address, architecture, state, credential_hash,
				  control_credential_ciphertext, gateway_credential_ciphertext,
				  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
				  reported_available_vcpus, reported_available_memory_mb,
				  reported_available_disk_mb, runtime_cohort_id, runtime_contract_version,
				  runtime_arch, runtime_kernel_sha256, runtime_firecracker_sha256,
				  runtime_jailer_sha256, runtime_python_rootfs_sha256,
				  runtime_desktop_rootfs_sha256)
				 VALUES ($1, $2, $3, $4, 'x86_64', 'ready', 'test', 'test', 'test',
				         4, 4096, 20480, now(), 4, 4096, 20480,
				         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
				         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
				[hostId, `provider-${hostId}`, regionId, `fd00:6e65:6865:${addressSuffix}::1`]
			);
			for (const [index, projectId] of projectIds.entries()) {
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
					  region_id, architecture, template_name, requested_ttl_seconds,
					  vcpus, memory_mb, disk_mb, expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6, 'x86_64', 'python', 900,
					         1, 512, 5120, now() + interval '15 minutes')`,
					[
						`m_org_quota_${index}_${randomUUID().replaceAll('-', '')}`,
						organizationId,
						projectId,
						`org-create-${index}-${randomUUID()}`,
						(index ? 'd' : 'c').repeat(64),
						regionId
					]
				);
			}
		});

		const rows = await database.query<{ id: string; project_id: string }>(
			`SELECT id, project_id FROM machines
			 WHERE organization_id = $1 AND region_id = $2 ORDER BY id`,
			[organizationId, regionId]
		);
		const scheduler = new Scheduler(database);
		const outcomes = await Promise.allSettled(
			rows.rows.map((machine) =>
				scheduler.reserve({
					organizationId,
					projectId: machine.project_id,
					region: regionId,
					architecture: 'x86_64',
					resources: { vcpus: 1, memoryMb: 512, diskMb: 5120 },
					machineId: machine.id
				})
			)
		);
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
		expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(QuotaExceeded);
		const admitted = await database.query<{ starting: string; reserved_vcpus: number }>(
			`SELECT count(*) FILTER (WHERE machine.state = 'starting') AS starting,
			        host.reserved_vcpus
			 FROM machines machine JOIN hosts host ON host.id = $2
			 WHERE machine.organization_id = $1 GROUP BY host.reserved_vcpus`,
			[organizationId, hostId]
		);
		expect(Number(admitted.rows[0]?.starting)).toBe(1);
		expect(admitted.rows[0]?.reserved_vcpus).toBe(1);

		await database.query(
			`UPDATE machines SET state = 'failed', stopped_at = now(), reservation_released_at = now()
			 WHERE organization_id = $1`,
			[organizationId]
		);
		await database.query(
			`UPDATE hosts SET reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
			 WHERE id = $1`,
			[hostId]
		);
	});

	it('durably drains a terminal runtime outbox and splits usage at UTC midnight', async () => {
		const organizationId = randomUUID();
		const projectId = randomUUID();
		const machineId = `m_usage_${randomUUID().replaceAll('-', '')}`;
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Usage test', $2)`,
				[organizationId, `usage-${organizationId}`]
			);
			await client.query(
				`INSERT INTO projects (id, organization_id, name, slug)
				 VALUES ($1, $2, 'Usage project', $3)`,
				[projectId, organizationId, `usage-${projectId}`]
			);
			await client.query(
				`INSERT INTO machines
			  (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
			   state, region_id, architecture, template_name, requested_ttl_seconds,
			   vcpus, memory_mb, disk_mb, ready, started_at, stopped_at,
			   reservation_released_at, expires_at)
			 VALUES ($1, $2, $3, 'usage-create', $4, 'stopped', 'ca-tor-1', 'x86_64',
			         'python', 900, 2, 1024, 5120, false, $5, $6, $6, $6)`,
				[
					machineId,
					organizationId,
					projectId,
					'c'.repeat(64),
					new Date('2026-08-08T23:55:00.000Z'),
					new Date('2026-08-09T00:05:00.000Z')
				]
			);
		});
		const reconciler = new MachineReconciler(database, new NoopHost(), new UsageLedger(database));
		await reconciler.run();
		const events = await database.query<{ usage_date: string; count: string }>(
			`SELECT (period_start AT TIME ZONE 'UTC')::date::text AS usage_date, count(*) AS count
			 FROM usage_events
			 WHERE machine_id = $1
			 GROUP BY (period_start AT TIME ZONE 'UTC')::date
			 ORDER BY 1`,
			[machineId]
		);
		expect(events.rows).toEqual([
			{ usage_date: '2026-08-08', count: '2' },
			{ usage_date: '2026-08-09', count: '2' }
		]);
		const finalized = await database.query<{ finalized: boolean; pending: string }>(
			`SELECT m.usage_finalized_at IS NOT NULL AS finalized,
			        count(o.*) FILTER (WHERE o.processed_at IS NULL) AS pending
			 FROM machines m LEFT JOIN usage_outbox o ON o.machine_id = m.id
			 WHERE m.id = $1 GROUP BY m.usage_finalized_at`,
			[machineId]
		);
		expect(finalized.rows[0]).toEqual({ finalized: true, pending: '0' });
	});

	it('recovers a lost registration response only until the host becomes active', async () => {
		const hosts = new HostService(
			database,
			new HostCredentialCipher('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='),
			['10.64.0.0/16']
		);
		const providerId = `latitude-${randomUUID()}`;
		const address = `10.64.2.${Math.floor(Math.random() * 200) + 1}`;
		const operatorOrganizationId = randomUUID();
		await database.query(
			`INSERT INTO organizations (id, slug, name)
			 VALUES ($1, $2, 'Registration recovery operator')`,
			[operatorOrganizationId, `enr-${randomUUID().slice(0, 8)}`]
		);
		const input = {
			providerId,
			regionId: 'ca-tor-1',
			address,
			architecture: 'x86_64' as const,
			totalVcpus: 8,
			totalMemoryMb: 16_384,
			totalDiskMb: 100_000,
			controlToken: 'control-'.padEnd(40, 'a'),
			gatewayToken: 'gateway-'.padEnd(40, 'b'),
			runtimeCohort: testRuntimeCohort
		};
		const issueEnrollment = () =>
			hosts.issueEnrollment({
				providerId: input.providerId,
				regionId: input.regionId,
				address: input.address,
				architecture: input.architecture,
				totalVcpus: input.totalVcpus,
				totalMemoryMb: input.totalMemoryMb,
				totalDiskMb: input.totalDiskMb,
				ttlSeconds: 600,
				issuedByOrganizationId: operatorOrganizationId,
				issuedByUserId: 'registration-recovery-test',
				runtimeCohort: testRuntimeCohort
			});
		const firstGrant = await issueEnrollment();
		const first = await hosts.register(firstGrant.token, input);
		const recoveryGrant = await issueEnrollment();
		const recovered = await hosts.register(recoveryGrant.token, input);
		expect(recovered.id).toBe(first.id);
		expect(await hosts.authenticate(first.id, recovered.credential)).toBe(true);
		await hosts.heartbeat(
			first.id,
			{
				state: 'ready',
				availableVcpus: 8,
				availableMemoryMb: 16_384,
				availableDiskMb: 100_000,
				machineCount: 0,
				kvmAvailable: true,
				daemonVersion: 'integration-test',
				runtimeCohort: testRuntimeCohort
			},
			recovered.credentialGeneration
		);
		await expect(issueEnrollment()).rejects.toMatchObject({ code: 'host_not_enrollable' });
		await expect(hosts.register(recoveryGrant.token, input)).rejects.toMatchObject({
			code: 'invalid_enrollment_grant'
		});
	});

	it('fairly reconciles more than one batch of continuously-running machines', async () => {
		const fleet = await seedFleet(database, 'fair');
		const host = new ObservingHost();
		await database.transaction(async (client) => {
			for (let index = 0; index < 205; index += 1) {
				const machineId = `m_fair_${String(index).padStart(3, '0')}_${randomUUID().replaceAll('-', '')}`;
				const hostMachineId = `local-fair-${String(index).padStart(3, '0')}`;
				const leaseId = randomUUID();
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
					  idempotency_key, idempotency_request_hash, state, region_id, architecture,
					  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
					  ready, placed_at, started_at, ready_at, expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, 'x86_64',
					         'python', 900, 1, 512, 5120, true, now(), now(), now(),
					         now() + interval '15 minutes')`,
					[
						machineId,
						fleet.organizationId,
						fleet.projectId,
						fleet.hostId,
						hostMachineId,
						leaseId,
						`fair-${index}`,
						'd'.repeat(64),
						fleet.regionId
					]
				);
				host.observations.set(hostMachineId, {
					id: hostMachineId,
					status: 'running',
					ready: true,
					lease_id: leaseId,
					lease_generation: 1,
					metadata: { public_machine_id: machineId },
					resources: { vcpus: 1, memory_mb: 512, disk_mb: 5120 }
				});
			}
		});

		const reconciler = new MachineReconciler(database, host);
		await reconciler.run();
		await reconciler.run();
		await reconciler.run();

		expect(new Set(host.getCalls).size).toBe(205);
		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
	});

	it('runs only one reconciler while the PostgreSQL singleton lock is held', async () => {
		const fleet = await seedFleet(database, 'singleton');
		const host = new ObservingHost();
		const machineId = `m_singleton_${randomUUID().replaceAll('-', '')}`;
		const hostMachineId = 'local-singleton';
		const leaseId = randomUUID();
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
			  idempotency_key, idempotency_request_hash, state, region_id, architecture,
			  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
			  ready, placed_at, started_at, ready_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, 'singleton', $7, 'running', $8, 'x86_64',
			         'python', 900, 1, 512, 5120, true, now(), now(), now(),
			         now() + interval '15 minutes')`,
			[
				machineId,
				fleet.organizationId,
				fleet.projectId,
				fleet.hostId,
				hostMachineId,
				leaseId,
				'e'.repeat(64),
				fleet.regionId
			]
		);
		let allowGet!: () => void;
		const getGate = new Promise<void>((resolve) => {
			allowGet = resolve;
		});
		let startedGet!: () => void;
		const getStarted = new Promise<void>((resolve) => {
			startedGet = resolve;
		});
		host.observations.set(hostMachineId, {
			id: hostMachineId,
			status: 'running',
			ready: true,
			lease_id: leaseId,
			lease_generation: 1,
			metadata: { public_machine_id: machineId },
			resources: { vcpus: 1, memory_mb: 512, disk_mb: 5120 }
		});
		const originalGet = host.get.bind(host);
		host.get = async (address, id) => {
			startedGet();
			await getGate;
			return originalGet(address, id);
		};
		const first = new MachineReconciler(database, host).run();
		await getStarted;
		await new MachineReconciler(database, host).run();
		expect(host.getCalls).toHaveLength(0);
		allowGet();
		await first;
		expect(host.getCalls).toEqual([hostMachineId]);
		await database.query(
			`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
			 stopped_at = now(), reservation_released_at = now(), usage_finalized_at = now()
			 WHERE id = $1`,
			[machineId]
		);
	});

	it('destroys and releases a host object that misses its readiness deadline', async () => {
		const fleet = await seedFleet(database, 'ready');
		const host = new ObservingHost();
		const machineId = `m_ready_${randomUUID().replaceAll('-', '')}`;
		const hostMachineId = 'local-never-ready';
		const leaseId = randomUUID();
		await database.transaction(async (client) => {
			await client.query(
				`UPDATE hosts SET reserved_vcpus = 1, reserved_memory_mb = 512,
				 reserved_disk_mb = 5120 WHERE id = $1`,
				[fleet.hostId]
			);
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
				  idempotency_key, idempotency_request_hash, state, region_id, architecture,
				  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
				  ready, placed_at, startup_deadline_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'never-ready', $7, 'starting', $8,
				         'x86_64', 'python', 900, 1, 512, 5120, false,
				         now() - interval '3 minutes', now() - interval '1 minute',
				         now() + interval '15 minutes')`,
				[
					machineId,
					fleet.organizationId,
					fleet.projectId,
					fleet.hostId,
					hostMachineId,
					leaseId,
					'f'.repeat(64),
					fleet.regionId
				]
			);
		});
		host.observations.set(hostMachineId, {
			id: hostMachineId,
			status: 'running',
			ready: false,
			lease_id: leaseId,
			lease_generation: 1,
			metadata: { public_machine_id: machineId },
			resources: { vcpus: 1, memory_mb: 512, disk_mb: 5120 }
		});

		await new MachineReconciler(database, host).run();
		const result = await database.query<{
			state: string;
			reservation_released: boolean;
			reserved_vcpus: number;
		}>(
			`SELECT m.state, m.reservation_released_at IS NOT NULL AS reservation_released,
			        h.reserved_vcpus
			 FROM machines m JOIN hosts h ON h.id = m.host_id WHERE m.id = $1`,
			[machineId]
		);
		expect(host.destroyCalls).toEqual([hostMachineId]);
		expect(result.rows[0]).toEqual({
			state: 'failed',
			reservation_released: true,
			reserved_vcpus: 0
		});
	});

	it('immediately terminalizes a starting machine when the host reports failure', async () => {
		const fleet = await seedFleet(database, 'terminal');
		const host = new ObservingHost();
		const machineId = `m_terminal_${randomUUID().replaceAll('-', '')}`;
		const hostMachineId = `local-terminal-${randomUUID()}`;
		const leaseId = randomUUID();
		await database.transaction(async (client) => {
			await client.query(
				`UPDATE hosts SET reserved_vcpus = 1, reserved_memory_mb = 512,
				 reserved_disk_mb = 5120 WHERE id = $1`,
				[fleet.hostId]
			);
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
				  idempotency_key, idempotency_request_hash, state, region_id, architecture,
				  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
				  ready, placed_at, startup_deadline_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'host-failed', $7, 'starting', $8,
				         'x86_64', 'python', 900, 1, 512, 5120, false,
				         now() - interval '20 seconds',
				         now() + interval '1 minute', now() + interval '15 minutes')`,
				[
					machineId,
					fleet.organizationId,
					fleet.projectId,
					fleet.hostId,
					hostMachineId,
					leaseId,
					'f'.repeat(64),
					fleet.regionId
				]
			);
		});
		host.observations.set(hostMachineId, {
			id: hostMachineId,
			status: 'failed',
			ready: false,
			lease_id: leaseId,
			lease_generation: 1,
			metadata: { public_machine_id: machineId },
			resources: { vcpus: 1, memory_mb: 512, disk_mb: 5120 }
		});

		await new MachineReconciler(database, host).run();
		const result = await database.query<{
			state: string;
			reservation_released: boolean;
			reserved_vcpus: number;
		}>(
			`SELECT m.state, m.reservation_released_at IS NOT NULL AS reservation_released,
			        h.reserved_vcpus
			 FROM machines m JOIN hosts h ON h.id = m.host_id WHERE m.id = $1`,
			[machineId]
		);
		expect(result.rows[0]).toEqual({
			state: 'failed',
			reservation_released: true,
			reserved_vcpus: 0
		});
		expect(host.destroyCalls).toEqual([]);
	});

	it('enqueues terminal usage beyond 100 even while prior outbox rows remain pending', async () => {
		const fleet = await seedFleet(database, 'enqueue');
		await database.transaction(async (client) => {
			for (let index = 0; index < 150; index += 1) {
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
					  state, region_id, architecture, template_name, requested_ttl_seconds,
					  vcpus, memory_mb, disk_mb, ready, started_at, stopped_at,
					  reservation_released_at, expires_at)
					 VALUES ($1, $2, $3, $4, $5, 'stopped', $6, 'x86_64', 'python', 900,
					         1, 512, 5120, false, now() - interval '1 minute', now(), now(), now())`,
					[
						`m_enqueue_${String(index).padStart(3, '0')}_${randomUUID().replaceAll('-', '')}`,
						fleet.organizationId,
						fleet.projectId,
						`enqueue-${index}`,
						'a'.repeat(64),
						fleet.regionId
					]
				);
			}
		});
		const reconciler = new MachineReconciler(database, new NoopHost());
		await reconciler.run();
		await reconciler.run();
		const count = await database.query<{ count: string }>(
			'SELECT count(*) FROM usage_outbox WHERE project_id = $1 AND final',
			[fleet.projectId]
		);
		expect(Number(count.rows[0]?.count)).toBe(150);
		await database.query(
			`UPDATE usage_outbox SET processed_at = now() WHERE project_id = $1 AND processed_at IS NULL`,
			[fleet.projectId]
		);
		await database.query('UPDATE machines SET usage_finalized_at = now() WHERE project_id = $1', [
			fleet.projectId
		]);
	});

	it('backs off poison usage rows so later outbox work is not starved', async () => {
		const fleet = await seedFleet(database, 'outbox');
		const failing = new Set<string>();
		const eventPrefix = `poison-${randomUUID()}`;
		let finalMachineId = '';
		await database.transaction(async (client) => {
			for (let index = 0; index < 101; index += 1) {
				const machineId = `m_outbox_${String(index).padStart(3, '0')}_${randomUUID().replaceAll('-', '')}`;
				if (index < 100) failing.add(machineId);
				else finalMachineId = machineId;
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, idempotency_key, idempotency_request_hash,
					  state, region_id, architecture, template_name, requested_ttl_seconds,
					  vcpus, memory_mb, disk_mb, ready, stopped_at, reservation_released_at,
					  usage_finalized_at, expires_at)
					 VALUES ($1, $2, $3, $4, $5, 'stopped', $6, 'x86_64', 'python', 900,
					         1, 512, 5120, false, now(), now(), now(), now())`,
					[
						machineId,
						fleet.organizationId,
						fleet.projectId,
						`outbox-${index}`,
						'b'.repeat(64),
						fleet.regionId
					]
				);
				await client.query(
					`INSERT INTO usage_outbox
					 (event_key, organization_id, project_id, machine_id, vcpus, memory_mb,
					  period_start, period_end, final, source)
					 VALUES ($1, $2, $3, $4, 1, 512, now() - interval '1 minute', now(),
					         false, 'reconciler')`,
					[
						`${eventPrefix}-${String(index).padStart(3, '0')}`,
						fleet.organizationId,
						fleet.projectId,
						machineId
					]
				);
			}
		});
		const usage = new SelectiveUsageLedger(database, failing);
		const reconciler = new MachineReconciler(database, new NoopHost(), usage);
		await reconciler.run();
		await reconciler.run();
		const result = await database.query<{ processed: boolean }>(
			`SELECT processed_at IS NOT NULL AS processed FROM usage_outbox WHERE machine_id = $1`,
			[finalMachineId]
		);
		expect(result.rows[0]?.processed).toBe(true);
		await database.query(
			`UPDATE usage_outbox SET processed_at = COALESCE(processed_at, now())
			 WHERE project_id = $1`,
			[fleet.projectId]
		);
	});
});
