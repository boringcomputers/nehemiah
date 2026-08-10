import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	AuthoritativeMetering,
	MeteringHostLifecycleError,
	MeteringRateLimitError,
	splitRuntimeAtUtcMidnight,
	type HostUsageObservation,
	type HostUsageObservationOutcome
} from '../../src/billing/metering.js';
import type { HostClient } from '../../src/clients/nehemiahd.js';
import { Database } from '../../src/db/client.js';
import { MachineReconciler } from '../../src/jobs/reconcile-machines.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const gibibyte = 1_073_741_824n;
const second = 1_000_000_000n;

databaseDescribe('authoritative metering PostgreSQL contract', () => {
	const database = new Database(databaseUrl!);
	const metering = new AuthoritativeMetering(database, 0);
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const hostId = randomUUID();
	const hostAddress = `fd00:6e65:6865:${hostId.replaceAll('-', '').slice(0, 4)}::1`;

	beforeAll(async () => {
		await database.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Metering test')`,
			[organizationId, `meter-${organizationId.slice(0, 12)}`]
		);
		await database.query(
			`INSERT INTO projects
			 (id, organization_id, slug, name, max_machines, max_vcpus, max_memory_mb, max_storage_mb)
			 VALUES ($1, $2, $3, 'Metering', 100, 100, 1048576, 1048576)`,
			[projectId, organizationId, `meter-${projectId.slice(0, 12)}`]
		);
		await database.query(
			`INSERT INTO hosts
			 (id, provider_id, region_id, address, architecture, state, credential_hash,
			  control_credential_ciphertext, gateway_credential_ciphertext,
			  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
			  runtime_cohort_id, runtime_contract_version, runtime_arch,
			  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
			  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
			 VALUES ($1, $2, 'ca-tor-1', $3, 'x86_64', 'ready',
			         'test', 'test', 'test', 128, 1048576, 1048576, now(),
			         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
			         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
			[hostId, `meter-${hostId}`, hostAddress]
		);
	});

	afterAll(async () => database.close());

	beforeEach(async () => {
		await database.query(
			`UPDATE hosts SET desired_state = 'active', state = 'ready',
			 credential_hash = 'test', control_credential_ciphertext = 'test',
			 gateway_credential_ciphertext = 'test', credential_generation = 1,
			 credential_status = 'active', credential_revoked_at = NULL,
			 last_metering_batch_at = NULL, metering_quarantined_at = NULL,
			 lifecycle_reason = NULL WHERE id = $1`,
			[hostId]
		);
	});

	const machine = async (): Promise<{
		machineId: string;
		hostMachineId: string;
		leaseId: string;
		bootId: string;
	}> => {
		const machineId = `m_meter_${randomUUID().replaceAll('-', '')}`;
		const hostMachineId = `m-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
		const leaseId = randomUUID();
		const bootId = randomUUID();
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
			  idempotency_key, idempotency_request_hash, state, region_id, architecture,
			  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb,
			  ready, ready_at, created_at, placed_at, started_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $1, repeat('a', 64), 'running',
			         'ca-tor-1', 'x86_64', 'python', 3600, 2, 1024, 5120,
			         true, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z',
			         '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z', now() + interval '1 hour')`,
			[machineId, organizationId, projectId, hostId, hostMachineId, leaseId]
		);
		return { machineId, hostMachineId, leaseId, bootId };
	};

	const observation = (
		identity: Awaited<ReturnType<typeof machine>>,
		sequence: number,
		kind: HostUsageObservation['kind'],
		runtimeNs: bigint,
		egressBytes: bigint,
		observedAt: string,
		overrides: Partial<HostUsageObservation> = {}
	): HostUsageObservation => ({
		machineId: identity.machineId,
		hostMachineId: identity.hostMachineId,
		leaseId: identity.leaseId,
		leaseGeneration: '1',
		hostBootId: identity.bootId,
		sequence: String(sequence),
		kind,
		quality: 'exact',
		qualityReason: 'none',
		runtimeNs: runtimeNs.toString(),
		egressBytes: egressBytes.toString(),
		egressCounterEpoch: '1',
		observedMonotonicNs: (100n * second + runtimeNs).toString(),
		observedAt,
		vcpus: 2,
		memoryBytes: gibibyte.toString(),
		processId: 4242,
		...overrides
	});
	const receipt = (
		identity: Awaited<ReturnType<typeof machine>>,
		sequence: number,
		outcome: HostUsageObservationOutcome
	) => ({
		leaseId: identity.leaseId,
		leaseGeneration: '1',
		hostBootId: identity.bootId,
		sequence: String(sequence),
		outcome,
		acknowledged: true
	});

	it('disables both legacy usage paths when authoritative metering is active', async () => {
		const identity = await machine();
		await database.query(
			`UPDATE machines SET reconcile_after = now() - interval '1 minute' WHERE id = $1`,
			[identity.machineId]
		);
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		const unsupported = async (): Promise<never> => {
			throw new Error('unexpected host operation');
		};
		const host: HostClient = {
			create: unsupported,
			destroy: unsupported,
			extend: unsupported,
			fork: unsupported,
			exec: unsupported,
			get: async (_address, hostMachineId) => ({
				id: hostMachineId,
				status: 'running',
				lease_id: identity.leaseId,
				lease_generation: 1,
				metadata: { public_machine_id: identity.machineId },
				ready: true,
				resources: { vcpus: 2, memory_mb: 1024, disk_mb: 5120 },
				network_policy: { mode: 'off', hostnames: [], cidrs: [] }
			})
		};
		await new MachineReconciler(database, host, undefined, metering).run();
		const legacy = await database.query<{
			outbox: string;
			reconciler_events: string;
			host_events: string;
		}>(
			`SELECT
			 (SELECT count(*) FROM usage_outbox WHERE machine_id = $1) AS outbox,
			 (SELECT count(*) FROM usage_events WHERE machine_id = $1 AND source = 'reconciler') AS reconciler_events,
			 (SELECT count(*) FROM usage_events WHERE machine_id = $1 AND source = 'host') AS host_events`,
			[identity.machineId]
		);
		expect(legacy.rows[0]).toEqual({ outbox: '0', reconciler_events: '0', host_events: '3' });
		await database.query(
			`UPDATE machines SET state = 'stopped', stopped_at = '2026-08-08T12:00:10Z',
			 usage_finalized_at = NULL WHERE id = $1`,
			[identity.machineId]
		);
		await new MachineReconciler(database, host, undefined, metering).run();
		const terminalLegacy = await database.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM usage_outbox WHERE machine_id = $1`,
			[identity.machineId]
		);
		expect(terminalLegacy.rows[0]?.count).toBe('0');
	});

	it('keeps old-host leases on legacy metering and closes the prefix at authoritative start', async () => {
		const legacyIdentity = await machine();
		expect(
			await metering.closeHostLoss(legacyIdentity.machineId, legacyIdentity.leaseId)
		).toBeUndefined();
		const legacyFinalization = await database.query<{ finalized: boolean }>(
			`SELECT usage_finalized_at IS NOT NULL AS finalized FROM machines WHERE id = $1`,
			[legacyIdentity.machineId]
		);
		expect(legacyFinalization.rows[0]?.finalized).toBe(false);
		const unsupported = async (): Promise<never> => {
			throw new Error('unexpected host operation');
		};
		const host: HostClient = {
			create: unsupported,
			destroy: unsupported,
			extend: unsupported,
			fork: unsupported,
			exec: unsupported,
			get: async (_address, hostMachineId) => ({
				id: hostMachineId,
				status: 'running',
				lease_id: legacyIdentity.leaseId,
				lease_generation: 1,
				metadata: { public_machine_id: legacyIdentity.machineId },
				ready: true,
				resources: { vcpus: 2, memory_mb: 1024, disk_mb: 5120 },
				network_policy: { mode: 'off', hostnames: [], cidrs: [] }
			})
		};
		await new MachineReconciler(database, host, undefined, metering).run();
		const legacyRows = await database.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM usage_outbox
			 WHERE machine_id = $1 AND source = 'reconciler'`,
			[legacyIdentity.machineId]
		);
		expect(legacyRows.rows[0]?.count).toBe('1');

		const cutoffIdentity = await machine();
		await metering.ingest(hostId, [
			observation(cutoffIdentity, 1, 'start', 0n, 0n, '2026-08-08T12:05:00.000Z')
		]);
		const cutoff = await database.query<{ start: Date; finish: Date; final: boolean }>(
			`SELECT period_start AS start, period_end AS finish, final
			 FROM usage_outbox WHERE machine_id = $1`,
			[cutoffIdentity.machineId]
		);
		expect(
			cutoff.rows.map((row) => ({
				start: row.start.toISOString(),
				finish: row.finish.toISOString(),
				final: row.final
			}))
		).toEqual([
			{ start: '2026-08-08T12:00:00.000Z', finish: '2026-08-08T12:05:00.000Z', final: false }
		]);
	});

	it('subtracts a delayed-start legacy overlap from authoritative cumulative runtime', async () => {
		const identity = await machine();
		await database.query(
			`UPDATE machines SET usage_checkpoint_at = '2026-08-08T12:01:00Z' WHERE id = $1`,
			[identity.machineId]
		);
		await database.query(
			`INSERT INTO usage_events
			 (event_key, organization_id, project_id, machine_id, dimension, quantity,
			  period_start, period_end, source)
			 VALUES
			 ($1, $2, $3, $4, 'vcpu_seconds', 120, '2026-08-08T12:00:00Z', '2026-08-08T12:01:00Z', 'reconciler'),
			 ($5, $2, $3, $4, 'gib_seconds', 60, '2026-08-08T12:00:00Z', '2026-08-08T12:01:00Z', 'reconciler')`,
			[
				`cutover:${identity.machineId}:vcpu`,
				organizationId,
				projectId,
				identity.machineId,
				`cutover:${identity.machineId}:memory`
			]
		);
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 120n * second, 0n, '2026-08-08T12:02:00.000Z')
		]);
		const totals = await database.query<{ dimension: string; quantity: string }>(
			`SELECT dimension, sum(quantity)::text AS quantity FROM usage_events
			 WHERE machine_id = $1 AND dimension IN ('vcpu_seconds', 'gib_seconds')
			 GROUP BY dimension ORDER BY dimension`,
			[identity.machineId]
		);
		expect(totals.rows).toEqual([
			{ dimension: 'gib_seconds', quantity: '120.000000000' },
			{ dimension: 'vcpu_seconds', quantity: '240.000000000' }
		]);
		const state = await database.query<{ projected_runtime_ns: string }>(
			`SELECT projected_runtime_ns::text FROM machine_meter_state WHERE machine_id = $1`,
			[identity.machineId]
		);
		expect(state.rows[0]?.projected_runtime_ns).toBe((120n * second).toString());
	});

	it('replays exact observations and rejects same-key different-payload evidence', async () => {
		const identity = await machine();
		const start = observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z');
		expect(await metering.ingest(hostId, [start])).toEqual([receipt(identity, 1, 'accepted')]);
		expect(await metering.ingest(hostId, [start])).toEqual([receipt(identity, 1, 'duplicate')]);
		const conflict = { ...start, processId: 4243 };
		expect(await metering.ingest(hostId, [conflict])).toEqual([
			receipt(identity, 1, 'rejected_payload_conflict')
		]);
		const counts = await database.query<{ observations: string; conflicts: string }>(
			`SELECT
			 (SELECT count(*) FROM host_usage_observations WHERE machine_id = $1) AS observations,
			 (SELECT count(*) FROM metering_exceptions
			  WHERE machine_id = $1 AND reason = 'payload_conflict') AS conflicts`,
			[identity.machineId]
		);
		expect(counts.rows[0]).toEqual({ observations: '1', conflicts: '1' });
		await expect(
			database.query(`UPDATE metering_exceptions SET reason = 'clock_skew' WHERE machine_id = $1`, [
				identity.machineId
			])
		).rejects.toMatchObject({ code: '55000' });
	});

	it('rechecks the authenticated heartbeat credential generation under the ingest lock', async () => {
		const identity = await machine();
		await expect(
			metering.ingest(
				hostId,
				[observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')],
				2
			)
		).rejects.toBeInstanceOf(MeteringHostLifecycleError);
		const persisted = await database.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM host_usage_observations WHERE machine_id = $1`,
			[identity.machineId]
		);
		expect(persisted.rows[0]?.count).toBe('0');
	});

	it('serializes durable host batch cadence across concurrent ingestors', async () => {
		const identity = await machine();
		const admitted = new AuthoritativeMetering(database);
		const start = observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z');
		const results = await Promise.allSettled([
			admitted.ingest(hostId, [start], 1),
			admitted.ingest(hostId, [start], 1)
		]);
		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		const rejected = results.find(({ status }) => status === 'rejected');
		expect(rejected).toMatchObject({
			status: 'rejected',
			reason: expect.any(MeteringRateLimitError)
		});
	});

	it('rejects far-future sequence floods before immutable insertion and quarantines once', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const flood = Array.from({ length: 256 }, (_, index) =>
			observation(
				identity,
				1_000_000 + index,
				'checkpoint',
				10n * second,
				100n,
				'2026-08-08T12:00:10.000Z'
			)
		);
		const receipts = await metering.ingest(hostId, flood);
		expect(receipts).toHaveLength(256);
		expect(receipts.every(({ outcome }) => outcome === 'quarantined')).toBe(true);
		const evidence = await database.query<{
			observations: string;
			exceptions: string;
			desired_state: string;
		}>(
			`SELECT
			 (SELECT count(*)::text FROM host_usage_observations WHERE machine_id = $1) AS observations,
			 (SELECT count(*)::text FROM metering_exceptions
			  WHERE machine_id = $1 AND reason = 'sequence_window_exceeded') AS exceptions,
			 desired_state::text
			 FROM hosts WHERE id = $2`,
			[identity.machineId, hostId]
		);
		expect(evidence.rows[0]).toEqual({
			observations: '1',
			exceptions: '1',
			desired_state: 'quarantined'
		});
		await expect(metering.ingest(hostId, flood)).rejects.toBeInstanceOf(MeteringHostLifecycleError);
	});

	it('rejects sequential no-progress floods before immutable insertion', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const flood = Array.from({ length: 256 }, (_, index) =>
			observation(identity, index + 2, 'checkpoint', 0n, 0n, '2026-08-08T12:00:00.000Z')
		);
		const receipts = await metering.ingest(hostId, flood);
		expect(receipts.every(({ outcome }) => outcome === 'quarantined')).toBe(true);
		const evidence = await database.query<{
			observations: string;
			exceptions: string;
			desired_state: string;
		}>(
			`SELECT
			 (SELECT count(*)::text FROM host_usage_observations WHERE machine_id = $1) AS observations,
			 (SELECT count(*)::text FROM metering_exceptions
			  WHERE machine_id = $1 AND reason = 'observation_rate_exceeded') AS exceptions,
			 desired_state::text
			 FROM hosts WHERE id = $2`,
			[identity.machineId, hostId]
		);
		expect(evidence.rows[0]).toEqual({
			observations: '1',
			exceptions: '1',
			desired_state: 'quarantined'
		});
	});

	it('bounds a same-wall-time sequential burst by cumulative database lease time', async () => {
		const identity = await machine();
		const anchor = new Date();
		await database.query(
			`UPDATE machines
			 SET created_at = $2::timestamptz, placed_at = $2::timestamptz,
			     started_at = $2::timestamptz, ready_at = $2::timestamptz,
			     expires_at = $2::timestamptz + interval '1 hour'
			 WHERE id = $1`,
			[identity.machineId, anchor]
		);
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, anchor.toISOString())
		]);
		const flood = Array.from({ length: 256 }, (_, index) => {
			const runtime = BigInt(index + 1) * 4n * second;
			return observation(
				identity,
				index + 2,
				'checkpoint',
				runtime,
				BigInt(index + 1) * 32_000_000n,
				anchor.toISOString()
			);
		});
		const receipts = await metering.ingest(hostId, flood);
		expect(receipts.some(({ outcome }) => outcome === 'quarantined')).toBe(true);
		const evidence = await database.query<{
			observations: number;
			exceptions: number;
			desired_state: string;
		}>(
			`SELECT
			 (SELECT count(*)::integer FROM host_usage_observations WHERE machine_id = $1)
			   AS observations,
			 (SELECT count(*)::integer FROM metering_exceptions
			  WHERE machine_id = $1 AND reason = 'observation_rate_exceeded') AS exceptions,
			 desired_state::text
			 FROM hosts WHERE id = $2`,
			[identity.machineId, hostId]
		);
		expect(evidence.rows[0]?.observations).toBeLessThanOrEqual(76);
		expect(evidence.rows[0]).toMatchObject({ exceptions: 1, desired_state: 'quarantined' });
	});

	it('quarantines physically impossible egress growth without poisoning raw usage', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const receipts = await metering.ingest(hostId, [
			observation(
				identity,
				2,
				'checkpoint',
				10n * second,
				18_446_744_073_709_551_615n,
				'2026-08-08T12:00:10.000Z'
			)
		]);
		expect(receipts).toEqual([receipt(identity, 2, 'quarantined')]);
		const evidence = await database.query<{
			observations: string;
			egress_events: string;
			exceptions: string;
		}>(
			`SELECT
			 (SELECT count(*)::text FROM host_usage_observations WHERE machine_id = $1) AS observations,
			 (SELECT count(*)::text FROM meter_raw_usage_events
			  WHERE machine_id = $1 AND dimension = 'egress') AS egress_events,
			 (SELECT count(*)::text FROM metering_exceptions
			  WHERE machine_id = $1 AND reason = 'egress_plausibility_exceeded') AS exceptions`,
			[identity.machineId]
		);
		expect(evidence.rows[0]).toEqual({ observations: '1', egress_events: '0', exceptions: '1' });
	});

	it('rejects an exact final before the authoritative lease is stopping or expired', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const receipts = await metering.ingest(hostId, [
			observation(identity, 2, 'final', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		expect(receipts).toEqual([receipt(identity, 2, 'quarantined')]);
		const evidence = await database.query<{
			observations: string;
			final_seen: boolean;
			finalized: boolean;
			exceptions: string;
		}>(
			`SELECT
			 (SELECT count(*)::text FROM host_usage_observations WHERE machine_id = machine.id)
			   AS observations,
			 meter.final_seen,
			 machine.usage_finalized_at IS NOT NULL AS finalized,
			 (SELECT count(*)::text FROM metering_exceptions
			  WHERE machine_id = machine.id AND reason = 'premature_final') AS exceptions
			 FROM machines machine JOIN machine_meter_state meter ON meter.machine_id = machine.id
			 WHERE machine.id = $1`,
			[identity.machineId]
		);
		expect(evidence.rows[0]).toEqual({
			observations: '1',
			final_seen: false,
			finalized: false,
			exceptions: '1'
		});
	});

	it('rejects a degraded final while the machine is still running', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const receipts = await metering.ingest(hostId, [
			observation(identity, 2, 'final', 10n * second, 100n, '2026-08-08T12:00:10.000Z', {
				quality: 'last_defensible',
				qualityReason: 'runtime_unavailable'
			})
		]);
		expect(receipts).toEqual([receipt(identity, 2, 'quarantined')]);
		const evidence = await database.query<{
			final_seen: boolean;
			finalized: boolean;
			exceptions: string;
		}>(
			`SELECT meter.final_seen,
			 machine.usage_finalized_at IS NOT NULL AS finalized,
			 (SELECT count(*)::text FROM metering_exceptions
			  WHERE machine_id = machine.id AND reason = 'premature_final') AS exceptions
			 FROM machines machine JOIN machine_meter_state meter ON meter.machine_id = machine.id
			 WHERE machine.id = $1`,
			[identity.machineId]
		);
		expect(evidence.rows[0]).toEqual({ final_seen: false, finalized: false, exceptions: '1' });
	});

	it('turns an integrity quarantine into stale-host loss and one durable fleet audit', async () => {
		const corrupted = await machine();
		const sibling = await machine();
		await metering.ingest(hostId, [
			observation(corrupted, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		await metering.ingest(hostId, [
			observation(corrupted, 2, 'checkpoint', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const unsupported = async (): Promise<never> => {
			throw new Error('unexpected host operation');
		};
		const host: HostClient = {
			create: unsupported,
			destroy: unsupported,
			extend: unsupported,
			fork: unsupported,
			exec: unsupported,
			get: unsupported
		};
		await new MachineReconciler(database, host, undefined, metering).run();
		const evidence = await database.query<{
			states: string[];
			released: string;
			credential_status: string;
			credential_hash: string | null;
			audits: string;
		}>(
			`SELECT
			 ARRAY(SELECT state::text FROM machines
			       WHERE id = ANY($1::text[]) ORDER BY id) AS states,
			 (SELECT count(*)::text FROM machines
			  WHERE id = ANY($1::text[]) AND reservation_released_at IS NOT NULL) AS released,
			 host.credential_status::text, host.credential_hash,
			 (SELECT count(*)::text FROM audit_events
			  WHERE event_key = 'host:' || host.id::text || ':metering-integrity-quarantine') AS audits
			 FROM hosts host WHERE host.id = $2`,
			[[corrupted.machineId, sibling.machineId], hostId]
		);
		expect(evidence.rows[0]).toEqual({
			states: ['lost', 'lost'],
			released: '2',
			credential_status: 'revoked',
			credential_hash: null,
			audits: '1'
		});
	});

	it('gives a healthy host time to deliver its durable final after control-plane stop', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		await database.query(
			`UPDATE machines SET state = 'stopped', stopped_at = statement_timestamp(), ready = false,
			 ready_at = NULL
			 WHERE id = $1`,
			[identity.machineId]
		);
		const unsupported = async (): Promise<never> => {
			throw new Error('unexpected host operation');
		};
		await new MachineReconciler(
			database,
			{
				create: unsupported,
				destroy: unsupported,
				extend: unsupported,
				fork: unsupported,
				exec: unsupported,
				get: unsupported
			},
			undefined,
			metering
		).run();
		const beforeFinal = await database.query<{ loss_closed_at: Date | null }>(
			'SELECT loss_closed_at FROM machine_meter_state WHERE machine_id = $1',
			[identity.machineId]
		);
		expect(beforeFinal.rows[0]?.loss_closed_at).toBeNull();
		expect(
			await metering.ingest(hostId, [
				observation(identity, 3, 'final', 20n * second, 200n, '2026-08-08T12:00:20.000Z')
			])
		).toEqual([receipt(identity, 3, 'accepted')]);
		const afterFinal = await database.query<{
			final_seen: boolean;
			quarantined_at: Date | null;
			desired_state: string;
		}>(
			`SELECT meter.final_seen, meter.quarantined_at, host.desired_state::text
			 FROM machine_meter_state meter JOIN hosts host ON host.id = meter.host_id
			 WHERE meter.machine_id = $1`,
			[identity.machineId]
		);
		expect(afterFinal.rows[0]).toEqual({
			final_seen: true,
			quarantined_at: null,
			desired_state: 'active'
		});
	});

	it('drains out-of-order delivery after the missing sequence without double usage', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z')
		]);
		const third = observation(
			identity,
			3,
			'checkpoint',
			20n * second,
			150n,
			'2026-08-08T12:00:20.000Z'
		);
		expect(await metering.ingest(hostId, [third])).toEqual([receipt(identity, 3, 'pending_gap')]);
		expect(
			await metering.ingest(hostId, [
				observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
			])
		).toEqual([receipt(identity, 2, 'accepted')]);
		expect(await metering.ingest(hostId, [third])).toEqual([receipt(identity, 3, 'duplicate')]);
		const raw = await database.query<{ unit: string; quantity: string }>(
			`SELECT unit, sum(quantity)::text AS quantity FROM meter_raw_usage_events
			 WHERE machine_id = $1 GROUP BY unit ORDER BY unit`,
			[identity.machineId]
		);
		expect(raw.rows).toEqual([
			{ unit: 'byte', quantity: '150' },
			{ unit: 'byte_nanosecond', quantity: (20n * second * gibibyte).toString() },
			{ unit: 'vcpu_nanosecond', quantity: (40n * second).toString() }
		]);
		const gap = await database.query<{ open: string; resolved: string }>(
			`SELECT count(*) FILTER (WHERE resolution.exception_id IS NULL)::text AS open,
			        count(*) FILTER (WHERE resolution.exception_id IS NOT NULL)::text AS resolved
			 FROM metering_exceptions exception
			 LEFT JOIN metering_exception_resolutions resolution ON resolution.exception_id = exception.id
			 WHERE exception.machine_id = $1 AND exception.reason = 'sequence_gap'`,
			[identity.machineId]
		);
		expect(gap.rows[0]).toEqual({ open: '0', resolved: '1' });
	});

	it('preserves exact quantities while splitting a checkpoint at UTC midnight', async () => {
		const identity = await machine();
		await database.query(`UPDATE machines SET state = 'stopping' WHERE id = $1`, [
			identity.machineId
		]);
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T23:59:55.000Z'),
			observation(identity, 2, 'final', 10n * second, 10n, '2026-08-09T00:00:05.000Z')
		]);
		const events = await database.query<{ day: string; unit: string; quantity: string }>(
			`SELECT (period_start AT TIME ZONE 'UTC')::date::text AS day,
			        unit, quantity::text
			 FROM meter_raw_usage_events
			 WHERE machine_id = $1 AND unit <> 'byte'
			 ORDER BY day, unit`,
			[identity.machineId]
		);
		expect(events.rows).toEqual([
			{ day: '2026-08-08', unit: 'byte_nanosecond', quantity: (5n * second * gibibyte).toString() },
			{ day: '2026-08-08', unit: 'vcpu_nanosecond', quantity: (10n * second).toString() },
			{ day: '2026-08-09', unit: 'byte_nanosecond', quantity: (5n * second * gibibyte).toString() },
			{ day: '2026-08-09', unit: 'vcpu_nanosecond', quantity: (10n * second).toString() }
		]);
		const total = events.rows.reduce((sum, row) => sum + BigInt(row.quantity), 0n);
		expect(total).toBe(10n * second * gibibyte + 20n * second);
	});

	it.each([
		[
			'counter reset',
			(identity: Awaited<ReturnType<typeof machine>>) =>
				observation(identity, 3, 'checkpoint', 5n * second, 50n, '2026-08-08T12:00:20.000Z'),
			'counter_reset'
		],
		[
			'monotonic discontinuity',
			(identity: Awaited<ReturnType<typeof machine>>) =>
				observation(identity, 3, 'checkpoint', 20n * second, 150n, '2026-08-08T12:00:20.000Z', {
					observedMonotonicNs: (125n * second).toString()
				}),
			'counter_reset'
		],
		[
			'clock skew',
			(identity: Awaited<ReturnType<typeof machine>>) =>
				observation(identity, 3, 'checkpoint', 20n * second, 150n, '2099-08-08T12:00:20.000Z'),
			'clock_skew'
		]
	] as const)('quarantines %s without adding ambiguous usage', async (_name, malformed, reason) => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		expect((await metering.ingest(hostId, [malformed(identity)]))[0]?.outcome).toBe('quarantined');
		const state = await database.query<{
			quarantine_reason: string;
			last_runtime_ns: string;
		}>(
			`SELECT quarantine_reason, last_runtime_ns::text
			 FROM machine_meter_state WHERE machine_id = $1`,
			[identity.machineId]
		);
		expect(state.rows[0]).toEqual({ quarantine_reason: reason, last_runtime_ns: '10000000000' });
	});

	it('quarantines an implausibly ancient start without creating a projection baseline', async () => {
		const identity = await machine();
		expect(
			await metering.ingest(hostId, [
				observation(identity, 1, 'start', 0n, 0n, '1970-01-01T00:00:00.000Z')
			])
		).toEqual([receipt(identity, 1, 'quarantined')]);
		const state = await database.query<{
			projected_runtime_ns: string;
			quarantine_reason: string;
		}>(
			`SELECT projected_runtime_ns::text, quarantine_reason
			 FROM machine_meter_state WHERE machine_id = $1`,
			[identity.machineId]
		);
		expect(state.rows[0]).toEqual({ projected_runtime_ns: '0', quarantine_reason: 'clock_skew' });
	});

	it('closes host loss at the last accepted observation and never detection time', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		const cutoff = await metering.closeHostLoss(identity.machineId, identity.leaseId);
		expect(cutoff?.toISOString()).toBe('2026-08-08T12:00:10.000Z');
		const rawBeforeLateDelivery = await database.query<{ quantity: string }>(
			`SELECT sum(quantity)::text AS quantity FROM meter_raw_usage_events
			 WHERE machine_id = $1 AND unit = 'vcpu_nanosecond'`,
			[identity.machineId]
		);
		expect(
			await metering.ingest(hostId, [
				observation(identity, 3, 'checkpoint', 20n * second, 200n, '2026-08-08T12:00:20.000Z')
			])
		).toEqual([receipt(identity, 3, 'quarantined')]);
		const result = await database.query<{ finalized: boolean; exceptions: string }>(
			`SELECT m.usage_finalized_at IS NOT NULL AS finalized,
			 (SELECT count(*) FROM metering_exceptions e
			  WHERE e.machine_id = m.id AND e.reason = 'host_lost_without_final') AS exceptions
			 FROM machines m WHERE m.id = $1`,
			[identity.machineId]
		);
		expect(result.rows[0]).toEqual({ finalized: true, exceptions: '1' });
		const rawAfterLateDelivery = await database.query<{ quantity: string }>(
			`SELECT sum(quantity)::text AS quantity FROM meter_raw_usage_events
			 WHERE machine_id = $1 AND unit = 'vcpu_nanosecond'`,
			[identity.machineId]
		);
		expect(rawAfterLateDelivery.rows[0]?.quantity).toBe(rawBeforeLateDelivery.rows[0]?.quantity);
	});

	it('records a degraded recovery final as an open exception at the prior high-water', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		const result = await metering.ingest(hostId, [
			observation(identity, 3, 'final', 10n * second, 100n, '2026-08-08T12:00:10.000Z', {
				quality: 'last_defensible',
				qualityReason: 'runtime_unavailable'
			})
		]);
		expect(result).toEqual([receipt(identity, 3, 'quarantined')]);
		const evidence = await database.query<{
			final_seen: boolean;
			quarantine_reason: string;
			finalized: boolean;
			cutoff: Date;
			exceptions: string;
			quality_reason: string;
		}>(
			`SELECT state.final_seen, state.quarantine_reason,
			        machine.usage_finalized_at IS NOT NULL AS finalized,
			        state.last_period_end AS cutoff,
			        (SELECT count(*) FROM metering_exceptions exception
			         WHERE exception.machine_id = machine.id
			           AND exception.reason = 'degraded_terminal'
			           AND NOT EXISTS (
			             SELECT 1 FROM metering_exception_resolutions resolution
			             WHERE resolution.exception_id = exception.id
			           )) AS exceptions,
			        observation.quality_reason
			 FROM machines machine
			 JOIN machine_meter_state state ON state.machine_id = machine.id
			 JOIN host_usage_observations observation ON observation.machine_id = machine.id
			   AND observation.sequence = 3
			 WHERE machine.id = $1`,
			[identity.machineId]
		);
		expect(evidence.rows[0]).toMatchObject({
			final_seen: true,
			quarantine_reason: 'degraded_terminal',
			finalized: true,
			exceptions: '1',
			quality_reason: 'runtime_unavailable'
		});
		expect(evidence.rows[0]?.cutoff.toISOString()).toBe('2026-08-08T12:00:10.000Z');
	});

	it('repairs a committed terminal transition whose host-loss finalization was interrupted', async () => {
		const identity = await machine();
		await metering.ingest(hostId, [
			observation(identity, 1, 'start', 0n, 0n, '2026-08-08T12:00:00.000Z'),
			observation(identity, 2, 'checkpoint', 10n * second, 100n, '2026-08-08T12:00:10.000Z')
		]);
		await database.query(
			`UPDATE machines SET state = 'lost', stopped_at = '2026-08-08T12:00:10Z',
			 usage_finalized_at = NULL WHERE id = $1`,
			[identity.machineId]
		);
		await database.query(
			`UPDATE machines SET reconcile_after = now() + interval '1 hour' WHERE id <> $1`,
			[identity.machineId]
		);
		const unsupported = async (): Promise<never> => {
			throw new Error('terminal repair must not call the host');
		};
		const host: HostClient = {
			create: unsupported,
			get: unsupported,
			destroy: unsupported,
			extend: unsupported,
			fork: unsupported,
			exec: unsupported
		};
		await new MachineReconciler(database, host, undefined, metering).run();
		const repaired = await database.query<{
			finalized: boolean;
			cutoff: Date;
			exceptions: string;
			legacy_rows: string;
		}>(
			`SELECT usage_finalized_at IS NOT NULL AS finalized, stopped_at AS cutoff,
			 (SELECT count(*) FROM metering_exceptions exception
			  WHERE exception.machine_id = machine.id
			    AND exception.reason = 'host_lost_without_final') AS exceptions,
			 (SELECT count(*) FROM usage_outbox outbox
			  WHERE outbox.machine_id = machine.id) AS legacy_rows
			 FROM machines machine WHERE id = $1`,
			[identity.machineId]
		);
		expect(repaired.rows[0]).toMatchObject({ finalized: true, exceptions: '1', legacy_rows: '0' });
		expect(repaired.rows[0]?.cutoff.toISOString()).toBe('2026-08-08T12:00:10.000Z');
	});

	it('splits nanosecond durations deterministically in memory', () => {
		const segments = splitRuntimeAtUtcMidnight(new Date('2026-08-08T23:59:59.500Z'), 2n * second);
		expect(segments.map((segment) => segment.runtimeNs)).toEqual([500_000_000n, 1_500_000_000n]);
		expect(segments.reduce((sum, segment) => sum + segment.runtimeNs, 0n)).toBe(2n * second);
	});
});
