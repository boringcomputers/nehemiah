import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import { PostgresMachineRepository, type Machine } from '../../src/domain/machines.js';
import { PostgresTemplateRepository, type TemplateDatabase } from '../../src/domain/templates.js';
import { CapacityUnavailable, Scheduler } from '../../src/scheduler/scheduler.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

interface Fixture {
	hostId: string;
	organizationId: string;
	projectId: string;
	region: string;
	templateId: string;
}

const deferred = (): Deferred => {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
};

const within = async <A>(promise: Promise<A>, message: string): Promise<A> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), 5_000);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
};

class PausingTemplateDatabase implements TemplateDatabase {
	readonly #pool: Pool;
	readonly #activeUseChecked: Deferred;
	readonly #resumeDelete: Deferred;

	constructor(connectionString: string, activeUseChecked: Deferred, resumeDelete: Deferred) {
		this.#pool = new Pool({
			application_name: 'template-race-delete',
			connectionString,
			max: 1
		});
		this.#activeUseChecked = activeUseChecked;
		this.#resumeDelete = resumeDelete;
	}

	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values: readonly unknown[] = []
	): Promise<QueryResult<R>> {
		return this.#pool.query<R>(text, [...values]);
	}

	async transaction<A>(operation: (client: PoolClient) => Promise<A>): Promise<A> {
		const client = await this.#pool.connect();
		let interceptedActiveUseCheck = false;
		try {
			await client.query('BEGIN');
			const hookedClient = new Proxy(client, {
				get: (target, property) => {
					if (property === 'query') {
						return async (text: string, values: readonly unknown[] = []) => {
							const result = await target.query(text, [...values]);
							if (
								!interceptedActiveUseCheck &&
								text.includes('SELECT 1') &&
								text.includes('FROM machines') &&
								text.includes("state NOT IN ('stopped', 'failed', 'lost')")
							) {
								interceptedActiveUseCheck = true;
								this.#activeUseChecked.resolve();
								await this.#resumeDelete.promise;
							}
							return result;
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				}
			}) as PoolClient;

			const result = await operation(hookedClient);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.#pool.end();
	}
}

const createFixture = async (database: Database, label: string): Promise<Fixture> => {
	const suffix = randomUUID();
	const compactSuffix = suffix.replaceAll('-', '');
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const hostId = randomUUID();
	const templateId = randomUUID();
	const region = `template-race-${label}-${suffix.slice(0, 8)}`;
	const checksum = `sha256:${'ab'.repeat(32)}`;

	await database.transaction(async (client) => {
		await client.query(
			`INSERT INTO regions (id, provider, display_name)
       VALUES ($1, 'integration', $2)`,
			[region, region]
		);
		await client.query(
			`
        INSERT INTO organizations (id, slug, name)
        VALUES ($1, $2, $3)
      `,
			[organizationId, `race-${label}-${suffix.slice(0, 8)}`, `Template race ${label}`]
		);
		await client.query(
			`
        INSERT INTO projects (
          id,
          organization_id,
          slug,
          name,
          max_machines,
          max_vcpus,
          max_memory_mb,
          max_storage_mb
        )
        VALUES ($1, $2, $3, $4, 20, 20, 32768, 102400)
      `,
			[projectId, organizationId, `race-${label}-${suffix.slice(9, 17)}`, `Race ${label}`]
		);
		await client.query(
			`
        INSERT INTO hosts (
          id,
          provider_id,
          region_id,
          address,
          architecture,
          state,
          credential_hash,
          control_credential_ciphertext,
          gateway_credential_ciphertext,
          total_vcpus,
          total_memory_mb,
          total_disk_mb,
          last_heartbeat_at,
          reported_available_vcpus,
          reported_available_memory_mb,
          reported_available_disk_mb,
          runtime_cohort_id,
          runtime_contract_version,
          runtime_arch,
          runtime_kernel_sha256,
          runtime_firecracker_sha256,
          runtime_jailer_sha256,
          runtime_python_rootfs_sha256,
          runtime_desktop_rootfs_sha256
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::inet,
          'x86_64',
          'ready',
          $5,
          $6,
          $7,
          8,
          16384,
          102400,
          now(),
          8,
          16384,
          102400,
          $8,
          4,
          'amd64',
          $9,
          $10,
          $11,
          $12,
          $13
        )
      `,
			[
				hostId,
				`provider-${compactSuffix}`,
				region,
				`10.${Number.parseInt(compactSuffix.slice(0, 2), 16) % 254}.${Number.parseInt(compactSuffix.slice(2, 4), 16) % 254}.10`,
				'credential-test',
				'control-ciphertext-test',
				'gateway-ciphertext-test',
				'a'.repeat(64),
				'b'.repeat(64),
				'c'.repeat(64),
				'd'.repeat(64),
				'e'.repeat(64),
				'f'.repeat(64)
			]
		);
		await client.query(
			`
        INSERT INTO templates (
          id,
          organization_id,
          project_id,
          name,
          version,
          host_template_name,
          manifest,
          object_key,
          checksum,
          size_bytes
        )
        VALUES ($1, $2, $3, $4, 'v1', $5, $6::jsonb, $7, $8, 4096)
      `,
			[
				templateId,
				organizationId,
				projectId,
				`race-${label}`,
				`t-${compactSuffix.slice(0, 29)}`,
				JSON.stringify({
					architecture: 'x86_64',
					checksum,
					schema_version: 1,
					template_id: templateId
				}),
				`templates/${organizationId}/${templateId}.tar.zst`,
				checksum
			]
		);
		await client.query(
			`
        INSERT INTO template_replicas (
          template_id,
          host_id,
          state,
          progress,
          verified_checksum
        )
        VALUES ($1, $2, 'ready', 100, $3)
      `,
			[templateId, hostId, checksum]
		);
	});

	return { hostId, organizationId, projectId, region, templateId };
};

const machineFor = (
	fixture: Fixture,
	machineId: string,
	idempotencyKey: string,
	templateId?: string
): Machine => ({
	architecture: 'x86_64',
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
	id: machineId,
	idempotencyRequestHash: 'a'.repeat(64),
	leaseId: randomUUID(),
	networkPolicy: { cidrs: [], hostnames: [], mode: 'off' },
	organizationId: fixture.organizationId,
	projectId: fixture.projectId,
	ready: false,
	region: fixture.region,
	requestedTtlSeconds: 900,
	resources: { diskMb: 5_120, memoryMb: 512, vcpus: 1 },
	state: 'requested',
	template: templateId ? undefined : 'python',
	templateId
});

const waitForCreateRowLock = async (database: Database, applicationName: string): Promise<void> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 5_000) {
		const result = await database.query<{ waiting: boolean }>(
			`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE application_name = $1
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE '%FOR SHARE OF t%'
        ) AS waiting
      `,
			[applicationName]
		);
		if (result.rows[0]?.waiting) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('concurrent template-backed machine creation never waited on the row lock');
};

const retireFixture = async (database: Database, fixture: Fixture): Promise<void> => {
	// insertRequested writes the append-only machine event ledger, so retain each
	// randomized fixture in this disposable integration database and make it inert.
	await database.query(
		`UPDATE machines
		 SET state = 'stopped', ready = false, ready_at = NULL,
		     stopped_at = now(), reservation_released_at = now()
		 WHERE organization_id = $1`,
		[fixture.organizationId]
	);
	await database.query(
		`UPDATE hosts
		 SET state = 'stale', last_heartbeat_at = now() - interval '1 day',
		     reserved_vcpus = 0, reserved_memory_mb = 0, reserved_disk_mb = 0
		 WHERE id = $1`,
		[fixture.hostId]
	);
};

databaseDescribe('managed template delete/create serialization (PostgreSQL)', () => {
	let database: Database;

	beforeAll(() => {
		database = new Database({ connectionString: databaseUrl, max: 8 });
	});

	afterAll(async () => {
		await database.close();
	});

	it('denies a create that waits after DELETE passed its active-use check and revokes routing', async () => {
		const fixture = await createFixture(database, 'concurrent');
		const activeUseChecked = deferred();
		const resumeDelete = deferred();
		const pausingDatabase = new PausingTemplateDatabase(
			databaseUrl!,
			activeUseChecked,
			resumeDelete
		);
		const applicationName = `template-race-create-${randomUUID().slice(0, 8)}`;
		const createDatabase = new Database({
			application_name: applicationName,
			connectionString: databaseUrl,
			max: 1
		});
		const machineId = `m_template_race_${randomUUID().replaceAll('-', '')}`;
		const idempotencyKey = `template-race-${randomUUID()}`;
		let deletePromise: Promise<'deleted' | 'in_use' | 'not_found'> | undefined;
		let createPromise: Promise<{ error?: unknown; succeeded: boolean }> | undefined;

		try {
			const templates = new PostgresTemplateRepository(pausingDatabase);
			const machines = new PostgresMachineRepository(createDatabase);
			deletePromise = templates.remove(
				fixture.templateId,
				fixture.organizationId,
				fixture.projectId
			);
			await within(activeUseChecked.promise, 'DELETE never reached its active-use check');

			createPromise = machines
				.insertRequested(
					machineFor(fixture, machineId, idempotencyKey, fixture.templateId),
					idempotencyKey
				)
				.then(
					() => ({ succeeded: true }),
					(error: unknown) => ({ error, succeeded: false })
				);
			await waitForCreateRowLock(database, applicationName);
			resumeDelete.resolve();

			assert.equal(await deletePromise, 'deleted');
			const createResult = await createPromise;
			assert.equal(createResult.succeeded, false);
			assert.match(String(createResult.error), /template is not available to this project/);

			const durableState = await database.query<{
				deleted: boolean;
				machine_count: string;
				replica_count: string;
			}>(
				`
          SELECT
            t.deleted_at IS NOT NULL AS deleted,
            (SELECT count(*) FROM machines WHERE id = $2) AS machine_count,
            (
              SELECT count(*)
              FROM template_replicas tr
              WHERE tr.template_id = t.id
            ) AS replica_count
          FROM templates t
          WHERE t.id = $1
        `,
				[fixture.templateId, machineId]
			);
			assert.deepEqual(durableState.rows[0], {
				deleted: true,
				machine_count: '0',
				replica_count: '0'
			});

			// Even if stale external work recreates a ready replica, the scheduler must
			// never route a deleted managed template.
			await database.query(
				`
          INSERT INTO template_replicas (
            template_id,
            host_id,
            state,
            progress,
            verified_checksum
          )
          SELECT id, $2, 'ready', 100, checksum
          FROM templates
          WHERE id = $1
        `,
				[fixture.templateId, fixture.hostId]
			);
			const scheduler = new Scheduler(database);
			await assert.rejects(
				scheduler.reserve({
					architecture: 'x86_64',
					organizationId: fixture.organizationId,
					projectId: fixture.projectId,
					region: fixture.region,
					resources: { diskMb: 5_120, memoryMb: 512, vcpus: 1 },
					templateId: fixture.templateId
				}),
				CapacityUnavailable
			);
			const reservations = await database.query<{
				disk: string;
				memory: number;
				vcpus: number;
			}>(
				`
          SELECT
            reserved_disk_mb AS disk,
            reserved_memory_mb AS memory,
            reserved_vcpus AS vcpus
          FROM hosts
          WHERE id = $1
        `,
				[fixture.hostId]
			);
			assert.deepEqual(reservations.rows[0], { disk: '0', memory: 0, vcpus: 0 });
		} finally {
			resumeDelete.resolve();
			await Promise.allSettled(
				[deletePromise, createPromise].filter(Boolean) as Promise<unknown>[]
			);
			await pausingDatabase.close();
			await createDatabase.close();
			await retireFixture(database, fixture);
		}
	});

	it('keeps an in-use template and its ready replica while preserving built-in creation', async () => {
		const fixture = await createFixture(database, 'sequential');
		const machines = new PostgresMachineRepository(database);
		const templates = new PostgresTemplateRepository(database);
		const managedMachineId = `m_template_in_use_${randomUUID().replaceAll('-', '')}`;
		const builtInMachineId = `m_builtin_${randomUUID().replaceAll('-', '')}`;

		try {
			await machines.insertRequested(
				machineFor(fixture, managedMachineId, `managed-${randomUUID()}`, fixture.templateId),
				`managed-${randomUUID()}`
			);
			assert.equal(
				await templates.remove(fixture.templateId, fixture.organizationId, fixture.projectId),
				'in_use'
			);

			const templateState = await database.query<{
				deleted: boolean;
				ready_replicas: string;
			}>(
				`
          SELECT
            deleted_at IS NOT NULL AS deleted,
            (
              SELECT count(*)
              FROM template_replicas tr
              WHERE tr.template_id = templates.id
                AND tr.state = 'ready'
            ) AS ready_replicas
          FROM templates
          WHERE id = $1
        `,
				[fixture.templateId]
			);
			assert.deepEqual(templateState.rows[0], { deleted: false, ready_replicas: '1' });

			const builtInKey = `builtin-${randomUUID()}`;
			await machines.insertRequested(machineFor(fixture, builtInMachineId, builtInKey), builtInKey);
			const builtIn = await database.query<{ template_name: string; template_id: string | null }>(
				'SELECT template_id, template_name FROM machines WHERE id = $1',
				[builtInMachineId]
			);
			assert.deepEqual(builtIn.rows[0], { template_id: null, template_name: 'python' });
		} finally {
			await retireFixture(database, fixture);
		}
	});
});
