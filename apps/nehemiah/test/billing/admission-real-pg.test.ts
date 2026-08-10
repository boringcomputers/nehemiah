import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingAdmissionPolicy, BillingAdmissionRejected } from '../../src/billing/admission.js';
import { privateBetaRates, type MeterDimension, type Rate } from '../../src/billing/rates.js';
import { StripeWebhookService } from '../../src/billing/stripe.js';
import { Database } from '../../src/db/client.js';
import { PostgresMachineRepository } from '../../src/domain/machines.js';
import { PostgresVolumeRepository, type Volume } from '../../src/domain/volumes.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const rates = (overrides: Partial<Record<MeterDimension, bigint>>): ReadonlyArray<Rate> =>
	privateBetaRates.map((rate) => ({
		...rate,
		unitPriceMicros: overrides[rate.dimension] ?? 0n
	}));

const tenant = async (
	database: Database,
	label: string
): Promise<{ organizationId: string; projectId: string }> => {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
	await database.transaction(async (client) => {
		await client.query(
			`INSERT INTO organizations
			 (id, slug, name, max_machines, max_vcpus, max_memory_mb, max_disk_mb, max_storage_mb)
			 VALUES ($1, $2, $3, 100, 100, 1048576, 10485760, 1048576)`,
			[organizationId, `${label}-${suffix}`, label]
		);
		await client.query(
			`INSERT INTO projects
			 (id, organization_id, slug, name, max_machines, max_vcpus, max_memory_mb,
			  max_storage_mb)
			 VALUES ($1, $2, $3, $4, 100, 100, 1048576, 1048576)`,
			[projectId, organizationId, `${label}-${suffix}`, label]
		);
	});
	return { organizationId, projectId };
};

const removeTenant = async (
	database: Database,
	organizationId: string,
	regionId?: string,
	hostId?: string
): Promise<void> => {
	await database.query('DELETE FROM volumes WHERE organization_id = $1', [organizationId]);
	await database.query('DELETE FROM machines WHERE organization_id = $1', [organizationId]);
	await database.query('DELETE FROM projects WHERE organization_id = $1', [organizationId]);
	await database.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
	if (hostId) await database.query('DELETE FROM hosts WHERE id = $1', [hostId]);
	if (regionId) await database.query('DELETE FROM regions WHERE id = $1', [regionId]);
};

databaseDescribe('billing admission with PostgreSQL serialization', () => {
	let database: Database;

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.ping();
	});

	afterAll(async () => {
		await database?.close();
	});

	it('prices durable usage and rejects exposure above the account spend cap', async () => {
		const fixture = await tenant(database, 'billing-usage-cap');
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO billing_accounts (organization_id, spend_cap_cents)
					 VALUES ($1, 1)`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO usage_events
					 (event_key, organization_id, project_id, dimension, quantity,
					  period_start, period_end, source)
					 VALUES ($1, $2, $3, 'vcpu_seconds', 1001,
					         now() - interval '1001 seconds', now(), 'billing-admission-test')`,
					[randomUUID(), fixture.organizationId, fixture.projectId]
				);
			});
			const policy = new BillingAdmissionPolicy(rates({ vcpu_seconds: 10n }));
			await expect(
				database.transaction(async (client) => {
					await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
						fixture.organizationId
					]);
					await policy.enforce(client, fixture.organizationId);
				})
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });
		} finally {
			// usage_events is append-only; retain this randomized fixture in the
			// ephemeral integration database instead of weakening that invariant.
		}
	});

	it('does not release spend-cap headroom while authoritative usage is delayed', async () => {
		const fixture = await tenant(database, 'billing-meter-delay');
		const regionId = `billing-${randomUUID()}`;
		const hostId = randomUUID();
		const machineId = `m_billing_${randomUUID().replaceAll('-', '')}`;
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO billing_accounts (organization_id, spend_cap_cents) VALUES ($1, 5)`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO regions (id, provider, display_name)
					 VALUES ($1, 'integration', 'Meter delay admission')`,
					[regionId]
				);
				await client.query(
					`INSERT INTO hosts
					 (id, provider_id, region_id, address, architecture, state, credential_hash,
					  control_credential_ciphertext, gateway_credential_ciphertext,
					  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
					  runtime_cohort_id, runtime_contract_version, runtime_arch,
					  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
					  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
					 VALUES ($1, $2, $3, $4, 'x86_64', 'stale', 'test', 'test', 'test',
					         8, 8192, 102400, now() - interval '1 day', $5, $6, $7, $8, $9, $10,
					         $11, $12)`,
					[
						hostId,
						`billing-delay-${hostId}`,
						regionId,
						`fd00:6e65:6865:${hostId.slice(0, 4)}::3`,
						testRuntimeCohort.id,
						testRuntimeCohort.contractVersion,
						testRuntimeCohort.arch,
						testRuntimeCohort.kernelSha256,
						testRuntimeCohort.firecrackerSha256,
						testRuntimeCohort.jailerSha256,
						testRuntimeCohort.pythonRootfsSha256,
						testRuntimeCohort.desktopRootfsSha256
					]
				);
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, host_machine_id,
					  idempotency_key, idempotency_request_hash,
					  state, region_id, architecture, template_name, requested_ttl_seconds,
					  vcpus, memory_mb, disk_mb, created_at, placed_at, started_at, expires_at,
					  runtime_cohort_id, source_sha256)
					 VALUES ($1, $2, $3, $4, $5, $1, repeat('d', 64), 'running', $6, 'x86_64',
					         'python', 60, 1, 1, 5120, now() - interval '30 seconds',
					         now() - interval '30 seconds', now() - interval '30 seconds',
					         now() + interval '30 seconds', $7, $8)`,
					[
						machineId,
						fixture.organizationId,
						fixture.projectId,
						hostId,
						`host-${machineId}`,
						regionId,
						testRuntimeCohort.id,
						testRuntimeCohort.pythonRootfsSha256
					]
				);
			});
			const policy = new BillingAdmissionPolicy(rates({ vcpu_seconds: 1_000n }));
			await expect(
				database.transaction(async (client) => {
					await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
						fixture.organizationId
					]);
					await policy.enforce(client, fixture.organizationId);
				})
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });

			await database.query(
				`UPDATE billing_accounts SET spend_cap_cents = 2 WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			await database.query(
				`UPDATE machines SET state = 'stopped', stopped_at = now() WHERE id = $1`,
				[machineId]
			);
			await expect(
				database.transaction(async (client) => {
					await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
						fixture.organizationId
					]);
					await policy.enforce(client, fixture.organizationId);
				})
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });
		} finally {
			await removeTenant(database, fixture.organizationId, regionId, hostId);
		}
	});

	it('counts an unflushed legacy cutover prefix before a later host high-water', async () => {
		const fixture = await tenant(database, 'billing-meter-cutover');
		const regionId = `billing-${randomUUID()}`;
		const hostId = randomUUID();
		const machineId = `m_billing_${randomUUID().replaceAll('-', '')}`;
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO billing_accounts (organization_id, spend_cap_cents) VALUES ($1, 10)`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO regions (id, provider, display_name)
					 VALUES ($1, 'integration', 'Meter cutover admission')`,
					[regionId]
				);
				await client.query(
					`INSERT INTO hosts
					 (id, provider_id, region_id, address, architecture, state, credential_hash,
					  control_credential_ciphertext, gateway_credential_ciphertext,
					  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
					  runtime_cohort_id, runtime_contract_version, runtime_arch,
					  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
					  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
					 VALUES ($1, $2, $3, $4, 'x86_64', 'stale', 'test', 'test', 'test',
					         8, 8192, 102400, now() - interval '1 day', $5, $6, $7, $8, $9, $10,
					         $11, $12)`,
					[
						hostId,
						`billing-cutover-${hostId}`,
						regionId,
						`fd00:6e65:6865:${hostId.slice(0, 4)}::4`,
						testRuntimeCohort.id,
						testRuntimeCohort.contractVersion,
						testRuntimeCohort.arch,
						testRuntimeCohort.kernelSha256,
						testRuntimeCohort.firecrackerSha256,
						testRuntimeCohort.jailerSha256,
						testRuntimeCohort.pythonRootfsSha256,
						testRuntimeCohort.desktopRootfsSha256
					]
				);
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, host_machine_id,
					  idempotency_key, idempotency_request_hash,
					  state, region_id, architecture, template_name, requested_ttl_seconds,
					  vcpus, memory_mb, disk_mb, created_at, placed_at, started_at, expires_at,
					  runtime_cohort_id, source_sha256)
					 VALUES ($1, $2, $3, $4, $5, $1, repeat('e', 64), 'running', $6, 'x86_64',
					         'python', 120, 1, 1, 5120, now() - interval '120 seconds',
					         now() - interval '120 seconds', now() - interval '120 seconds', now(),
					         $7, $8)`,
					[
						machineId,
						fixture.organizationId,
						fixture.projectId,
						hostId,
						`host-${machineId}`,
						regionId,
						testRuntimeCohort.id,
						testRuntimeCohort.pythonRootfsSha256
					]
				);
				await client.query(
					`INSERT INTO usage_outbox
					 (event_key, organization_id, project_id, machine_id, vcpus, memory_mb,
					  period_start, period_end, final, source)
					 VALUES ($1, $2, $3, $4, 1, 1, now() - interval '120 seconds',
					         now() - interval '60 seconds', false, 'reconciler')`,
					[`cutover-prefix:${machineId}`, fixture.organizationId, fixture.projectId, machineId]
				);
				await client.query(
					`INSERT INTO usage_events
					 (event_key, organization_id, project_id, machine_id, dimension, quantity,
					  period_start, period_end, source)
					 VALUES ($1, $2, $3, $4, 'vcpu_seconds', 60,
					         now() - interval '60 seconds', now(), 'host')`,
					[`cutover-host:${machineId}`, fixture.organizationId, fixture.projectId, machineId]
				);
			});
			const policy = new BillingAdmissionPolicy(rates({ vcpu_seconds: 1_000n }));
			await expect(
				database.transaction(async (client) => {
					await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
						fixture.organizationId
					]);
					await policy.enforce(client, fixture.organizationId);
				})
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });
		} finally {
			// The host usage event is append-only, so keep this randomized fixture
			// as inert evidence in the disposable integration database.
			await database.query(
				`UPDATE machines SET state = 'stopped', stopped_at = now(),
				 usage_finalized_at = now(), reservation_released_at = now()
				 WHERE id = $1`,
				[machineId]
			);
			await database.query(`UPDATE usage_outbox SET processed_at = now() WHERE machine_id = $1`, [
				machineId
			]);
		}
	});

	it('admits only one concurrent machine commitment under an aggregate cap', async () => {
		const fixture = await tenant(database, 'billing-machine-cap');
		const regionId = `billing-${randomUUID()}`;
		const hostId = randomUUID();
		const machineIds = [
			`m_billing_${randomUUID().replaceAll('-', '')}`,
			`m_billing_${randomUUID().replaceAll('-', '')}`
		];
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO billing_accounts (organization_id, spend_cap_cents)
					 VALUES ($1, 1)`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO regions (id, provider, display_name)
					 VALUES ($1, 'integration', 'Billing admission')`,
					[regionId]
				);
				await client.query(
					`INSERT INTO hosts
					 (id, provider_id, region_id, address, architecture, state, credential_hash,
					  control_credential_ciphertext, gateway_credential_ciphertext,
					  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
					  reported_available_vcpus, reported_available_memory_mb,
					  reported_available_disk_mb, runtime_cohort_id,
					  runtime_contract_version, runtime_arch, runtime_kernel_sha256,
					  runtime_firecracker_sha256, runtime_jailer_sha256,
					  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
					 VALUES ($1, $2, $3, $4, 'aarch64', 'ready', 'test', 'test', 'test',
					         8, 8192, 102400, now(), 8, 8192, 102400,
					         repeat('a', 64), 4, 'arm64', repeat('b', 64), repeat('c', 64),
					         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
					[hostId, `provider-${hostId}`, regionId, `fd00:6e65:6865:${hostId.slice(0, 4)}::1`]
				);
				for (const [index, machineId] of machineIds.entries()) {
					await client.query(
						`INSERT INTO machines
						 (id, organization_id, project_id, idempotency_key,
						  idempotency_request_hash, region_id, architecture, template_name,
						  requested_ttl_seconds, vcpus, memory_mb, disk_mb, expires_at)
						 VALUES ($1, $2, $3, $4, $5, $6, 'aarch64', 'python', 900,
						         1, 512, 5120, now() + interval '900 seconds')`,
						[
							machineId,
							fixture.organizationId,
							fixture.projectId,
							`billing-create-${index}-${randomUUID()}`,
							(index ? 'b' : 'a').repeat(64),
							regionId
						]
					);
				}
			});
			const scheduler = new Scheduler(
				database,
				new BillingAdmissionPolicy(rates({ vcpu_seconds: 10n }))
			);
			const outcomes = await Promise.allSettled(
				machineIds.map((machineId) =>
					scheduler.reserve({
						organizationId: fixture.organizationId,
						projectId: fixture.projectId,
						region: regionId,
						architecture: 'aarch64',
						resources: { vcpus: 1, memoryMb: 512, diskMb: 5120 },
						machineId
					})
				)
			);
			expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
			const rejected = outcomes.find(({ status }) => status === 'rejected');
			expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
				BillingAdmissionRejected
			);
			expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
				code: 'spend_cap_exceeded'
			});
			const durable = await database.query<{ starting: string; operations: string }>(
				`SELECT count(*) FILTER (WHERE state = 'starting')::text AS starting,
				        (SELECT count(*) FROM machine_events
				          WHERE organization_id = $1 AND to_state = 'starting')::text AS operations
				 FROM machines WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			expect(durable.rows[0]).toEqual({ starting: '1', operations: '1' });
		} finally {
			// machine_events is append-only; retain this randomized fixture in the
			// ephemeral integration database instead of weakening that invariant,
			// but make it inert for concurrently running global lifecycle jobs.
			await database.query(
				`UPDATE machines SET state = 'stopped', ready = false, ready_at = NULL,
				        stopped_at = now(), reservation_released_at = now()
				 WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			await database.query(
				`UPDATE hosts SET state = 'stale', last_heartbeat_at = now() - interval '1 day',
				        reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
				 WHERE id = $1`,
				[hostId]
			);
		}
	});

	it('rejects machine extend and fork before writing operations', async () => {
		const fixture = await tenant(database, 'billing-machine-mutations');
		const regionId = `billing-${randomUUID()}`;
		const hostId = randomUUID();
		const machineId = `m_billing_${randomUUID().replaceAll('-', '')}`;
		try {
			await database.transaction(async (client) => {
				await client.query(
					`INSERT INTO billing_accounts (organization_id, delinquent_at)
					 VALUES ($1, now())`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO regions (id, provider, display_name)
					 VALUES ($1, 'integration', 'Billing mutation admission')`,
					[regionId]
				);
				await client.query(
					`INSERT INTO hosts
					 (id, provider_id, region_id, address, architecture, state, credential_hash,
					  control_credential_ciphertext, gateway_credential_ciphertext,
					  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
					  reported_available_vcpus, reported_available_memory_mb,
					  reported_available_disk_mb, runtime_cohort_id,
					  runtime_contract_version, runtime_arch, runtime_kernel_sha256,
					  runtime_firecracker_sha256, runtime_jailer_sha256,
					  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
					 VALUES ($1, $2, $3, $4, 'aarch64', 'ready', 'test', 'test', 'test',
					         8, 8192, 102400, now(), 8, 8192, 102400,
					         repeat('a', 64), 4, 'arm64', repeat('b', 64), repeat('c', 64),
					         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
					[hostId, `provider-${hostId}`, regionId, `fd00:6e65:6865:${hostId.slice(0, 4)}::2`]
				);
				await client.query(
					`INSERT INTO machines
					 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
					  idempotency_key, idempotency_request_hash, state, region_id, architecture,
					  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb, ready,
					  ready_at, expires_at)
					 VALUES ($1, $2, $3, $4, 'host-machine', $5, $6, $7, 'running', $8,
					         'aarch64', 'python', 900, 1, 512, 5120, true,
					         now(), now() + interval '60 seconds')`,
					[
						machineId,
						fixture.organizationId,
						fixture.projectId,
						hostId,
						randomUUID(),
						`billing-source-${randomUUID()}`,
						'c'.repeat(64),
						regionId
					]
				);
			});
			const repository = new PostgresMachineRepository(
				database,
				new BillingAdmissionPolicy(rates({ vcpu_seconds: 10n }))
			);
			await expect(
				repository.beginExtend(
					machineId,
					fixture.organizationId,
					fixture.projectId,
					`extend-${randomUUID()}`,
					'a'.repeat(64),
					900
				)
			).rejects.toMatchObject({ code: 'billing_delinquent' });

			await database.query(
				`UPDATE billing_accounts SET delinquent_at = NULL, spend_cap_cents = 0
				 WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			await expect(
				repository.beginFork(
					machineId,
					fixture.organizationId,
					fixture.projectId,
					`fork-${randomUUID()}`,
					'b'.repeat(64),
					1,
					randomUUID()
				)
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });
			const operations = await database.query<{ extends: string; forks: string }>(
				`SELECT
				   (SELECT count(*) FROM machine_extend_operations
				     WHERE machine_id = $1)::text AS extends,
				   (SELECT count(*) FROM machine_fork_operations
				     WHERE source_machine_id = $1)::text AS forks`,
				[machineId]
			);
			expect(operations.rows[0]).toEqual({ extends: '0', forks: '0' });
		} finally {
			await removeTenant(database, fixture.organizationId, regionId, hostId);
		}
	});

	it('rejects delinquent volume creation and PUT reservations, and enforces the cap', async () => {
		const fixture = await tenant(database, 'billing-volume-admission');
		const now = new Date();
		const repository = new PostgresVolumeRepository(
			database,
			new BillingAdmissionPolicy(rates({ storage_gib_hours: 10_000n }))
		);
		const volume: Volume = {
			id: `vol_${randomUUID().replaceAll('-', '')}`,
			organizationId: fixture.organizationId,
			projectId: fixture.projectId,
			objectPrefix: `organizations/${fixture.organizationId}/projects/${fixture.projectId}/billing/`,
			sizeLimitBytes: 1_048_576,
			observedSizeBytes: 0,
			createdAt: now,
			expiresAt: new Date(now.getTime() + 3_600_000)
		};
		try {
			await database.query(
				`INSERT INTO billing_accounts (organization_id, delinquent_at)
				 VALUES ($1, now())`,
				[fixture.organizationId]
			);
			await expect(
				repository.admitCreate(volume, `volume-${randomUUID()}`, 'a'.repeat(64))
			).rejects.toMatchObject({ code: 'billing_delinquent' });
			await database.transaction(async (client) => {
				await client.query(
					`UPDATE billing_accounts SET delinquent_at = NULL, spend_cap_cents = NULL
					 WHERE organization_id = $1`,
					[fixture.organizationId]
				);
				await client.query(
					`INSERT INTO volumes
					 (id, organization_id, project_id, object_prefix, size_limit_bytes,
					  observed_size_bytes, created_at, expires_at)
					 VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
					[
						volume.id,
						volume.organizationId,
						volume.projectId,
						volume.objectPrefix,
						volume.sizeLimitBytes,
						volume.createdAt,
						volume.expiresAt
					]
				);
			});
			await database.query(
				`UPDATE billing_accounts SET spend_cap_cents = 0 WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			await expect(
				repository.reserveWriteGrant({
					id: volume.id,
					organizationId: volume.organizationId,
					projectId: volume.projectId,
					observedSizeBytes: 0,
					now,
					expiresAt: new Date(now.getTime() + 60_000)
				})
			).rejects.toMatchObject({ code: 'spend_cap_exceeded' });
			await database.query(
				`UPDATE billing_accounts SET spend_cap_cents = NULL, delinquent_at = now()
				 WHERE organization_id = $1`,
				[fixture.organizationId]
			);
			await expect(
				repository.reserveWriteGrant({
					id: volume.id,
					organizationId: volume.organizationId,
					projectId: volume.projectId,
					observedSizeBytes: 0,
					now,
					expiresAt: new Date(now.getTime() + 60_000)
				})
			).rejects.toMatchObject({ code: 'billing_delinquent' });
			const reservations = await database.query<{ count: string }>(
				`SELECT count(*)::text FROM volume_write_grant_reservations
				 WHERE volume_id = $1`,
				[volume.id]
			);
			expect(reservations.rows[0]?.count).toBe('0');
		} finally {
			await removeTenant(database, fixture.organizationId);
		}
	});

	it('audits Stripe delinquency transitions atomically with a system actor', async () => {
		const fixture = await tenant(database, 'billing-stripe-audit');
		const customer = `cus_${randomUUID().replaceAll('-', '')}`;
		const failedEventId = `evt_${randomUUID().replaceAll('-', '')}`;
		const paidEventId = `evt_${randomUUID().replaceAll('-', '')}`;
		await database.query(
			`INSERT INTO billing_accounts (organization_id, stripe_customer_id)
			 VALUES ($1, $2)`,
			[fixture.organizationId, customer]
		);
		const stripe = new StripeWebhookService(database);
		expect(
			await stripe.process(
				{
					id: failedEventId,
					type: 'invoice.payment_failed',
					created: 1_786_240_000,
					data: { object: { id: 'in_audit', customer } }
				},
				{ requestId: 'stripe-request-failed' }
			)
		).toBe(true);
		expect(
			await stripe.process({
				id: failedEventId,
				type: 'invoice.payment_failed',
				created: 1_786_240_000,
				data: { object: { id: 'in_audit', customer } }
			})
		).toBe(false);
		expect(
			await stripe.process(
				{
					id: paidEventId,
					type: 'invoice.paid',
					created: 1_786_240_001,
					data: { object: { id: 'in_audit', customer } }
				},
				{ requestId: 'stripe-request-paid' }
			)
		).toBe(true);

		const result = await database.query<{
			delinquent_at: Date | null;
			processed: string;
			audits: string;
			actors: string[];
			request_ids: string[];
			states: string[];
		}>(
			`SELECT account.delinquent_at,
			        (SELECT count(*) FROM stripe_events WHERE id = ANY($2::text[]))::text AS processed,
			        count(audit.*)::text AS audits,
			        array_agg(audit.actor_type || ':' || audit.actor_id ORDER BY audit.id) AS actors,
			        array_agg(audit.request_id ORDER BY audit.id) AS request_ids,
			        array_agg(audit.metadata->>'state' ORDER BY audit.id) AS states
			 FROM billing_accounts account
			 JOIN audit_events audit ON audit.organization_id = account.organization_id
			   AND audit.action = 'billing.delinquency_changed'
			 WHERE account.organization_id = $1
			 GROUP BY account.organization_id, account.delinquent_at`,
			[fixture.organizationId, [failedEventId, paidEventId]]
		);
		expect(result.rows[0]).toEqual({
			delinquent_at: null,
			processed: '2',
			audits: '2',
			actors: ['system:stripe', 'system:stripe'],
			request_ids: ['stripe-request-failed', 'stripe-request-paid'],
			states: ['delinquent', 'current']
		});
		// Audit rows are append-only and intentionally retain this randomized
		// tenant fixture as evidence in the ephemeral integration database.
	});

	it('applies Stripe delinquency by source order and audits stale transitions', async () => {
		const fixture = await tenant(database, 'billing-stripe-order');
		const customer = `cus_${randomUUID().replaceAll('-', '')}`;
		await database.query(
			`INSERT INTO billing_accounts (organization_id, stripe_customer_id)
			 VALUES ($1, $2)`,
			[fixture.organizationId, customer]
		);
		const stripe = new StripeWebhookService(database);
		const event = (
			id: string,
			invoiceId: string,
			type: 'invoice.paid' | 'invoice.payment_failed',
			created: number
		) => ({ id, type, created, data: { object: { id: invoiceId, customer } } });

		await stripe.process(event('evt_failed_200', 'in_a', 'invoice.payment_failed', 200));
		await stripe.process(event('evt_paid_100', 'in_a', 'invoice.paid', 100));
		expect(
			(
				await database.query<{ delinquent: boolean }>(
					'SELECT delinquent_at IS NOT NULL AS delinquent FROM billing_accounts WHERE organization_id = $1',
					[fixture.organizationId]
				)
			).rows[0]?.delinquent
		).toBe(true);

		await stripe.process(event('evt_paid_300', 'in_a', 'invoice.paid', 300));
		await stripe.process(event('evt_failed_250', 'in_a', 'invoice.payment_failed', 250));
		await stripe.process(event('evt_paid_400', 'in_a', 'invoice.paid', 400));
		await stripe.process(event('evt_failed_400', 'in_a', 'invoice.payment_failed', 400));
		await stripe.process(event('evt_paid_400_late', 'in_a', 'invoice.paid', 400));

		// Paying invoice A cannot clear a later failure for invoice B.
		await stripe.process(event('evt_failed_b_500', 'in_b', 'invoice.payment_failed', 500));
		await stripe.process(event('evt_paid_a_600', 'in_a', 'invoice.paid', 600));
		expect(
			(
				await database.query<{ delinquent: boolean }>(
					'SELECT delinquent_at IS NOT NULL AS delinquent FROM billing_accounts WHERE organization_id = $1',
					[fixture.organizationId]
				)
			).rows[0]?.delinquent
		).toBe(true);
		await stripe.process(event('evt_paid_b_700', 'in_b', 'invoice.paid', 700));

		const result = await database.query<{
			delinquent: boolean;
			open_invoices: string;
			invoice_states: string[];
			ignored: string;
			invoice_audits: string;
		}>(
			`SELECT delinquent_at IS NOT NULL AS delinquent,
			        (SELECT count(*) FILTER (WHERE failed)::text
			           FROM stripe_invoice_delinquency
			          WHERE organization_id = $1) AS open_invoices,
			        (SELECT array_agg(stripe_invoice_id || ':' || failed::text || ':' ||
			                          stripe_event_id ORDER BY stripe_invoice_id)
			           FROM stripe_invoice_delinquency
			          WHERE organization_id = $1) AS invoice_states,
			        (SELECT count(*)::text FROM audit_events
			          WHERE organization_id = $1
			            AND action = 'billing.delinquency_event_ignored') AS ignored,
			        (SELECT count(*)::text FROM audit_events
			          WHERE organization_id = $1
			            AND action = 'billing.invoice_delinquency_changed') AS invoice_audits
			 FROM billing_accounts WHERE organization_id = $1`,
			[fixture.organizationId]
		);
		expect(result.rows[0]).toEqual({
			delinquent: false,
			open_invoices: '0',
			invoice_states: ['in_a:false:evt_paid_a_600', 'in_b:false:evt_paid_b_700'],
			ignored: '3',
			invoice_audits: '6'
		});

		const unmatchedId = `evt_unmatched_${randomUUID().replaceAll('-', '')}`;
		await expect(
			stripe.process({
				id: unmatchedId,
				type: 'invoice.payment_failed',
				created: 800,
				data: { object: { id: 'in_unmatched', customer: 'cus_unmatched' } }
			})
		).rejects.toThrow('not linked');
		const unmatched = await database.query<{ count: string }>(
			'SELECT count(*)::text FROM stripe_events WHERE id = $1',
			[unmatchedId]
		);
		expect(unmatched.rows[0]?.count).toBe('0');
	});
});
