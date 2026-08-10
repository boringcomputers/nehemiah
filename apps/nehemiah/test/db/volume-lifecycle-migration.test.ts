import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const migration = (name: string): Promise<string> =>
	readFile(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8');

databaseDescribe('volume lifecycle migration', () => {
	let database: Database;

	beforeAll(() => {
		database = new Database(databaseUrl!);
	});

	afterAll(async () => {
		await database?.close();
	});

	it('gives legacy null expiry a migration-time grace and repairs half-present identity', async () => {
		const schema = `volume_lifecycle_${randomUUID().replaceAll('-', '')}`;
		const names = [
			'0001_initial.sql',
			'0002_reconciliation_claims.sql',
			'0003_audit_operations.sql',
			'0004_create_operation_claims.sql',
			'0005_host_lifecycle.sql',
			'0006_extend_operations.sql',
			'0007_fork_operations.sql',
			'0008_volume_grant_reservations.sql'
		];
		const sql = await Promise.all(names.map(migration));
		const lifecycle = await migration('0009_volume_deletion_lifecycle.sql');
		await database.transaction(async (client) => {
			await client.query(`CREATE SCHEMA "${schema}"`);
			try {
				await client.query(`SET LOCAL search_path TO "${schema}"`);
				for (const contents of sql) await client.query(contents);
				const organizationId = randomUUID();
				const projectId = randomUUID();
				const createdAt = new Date('2025-01-02T03:04:05.000Z');
				await client.query(
					`INSERT INTO organizations (id, slug, name)
					 VALUES ($1, 'legacy-volume-org', 'Legacy volume organization')`,
					[organizationId]
				);
				await client.query(
					`INSERT INTO projects (id, organization_id, slug, name)
					 VALUES ($1, $2, 'legacy-volume-project', 'Legacy volume project')`,
					[projectId, organizationId]
				);
				await client.query(
					`INSERT INTO volumes
					 (id, organization_id, project_id, object_prefix, size_limit_bytes,
					  observed_size_bytes, created_at, expires_at, idempotency_key,
					  create_request_hash)
					 VALUES
					 ('vol_legacy_expiry_one', $1, $2, 'legacy/one/', 1024, 0, $3, NULL,
					  'legacy-key', NULL),
					 ('vol_legacy_expiry_two', $1, $2, 'legacy/two/', 1024, 0, $3, NULL,
					  NULL, repeat('a', 64))`,
					[organizationId, projectId, createdAt]
				);

				const migrationStarted = (
					await client.query<{ observed_at: Date }>('SELECT clock_timestamp() AS observed_at')
				).rows[0]!.observed_at;
				await client.query(lifecycle);
				const migrationFinished = (
					await client.query<{ observed_at: Date }>('SELECT clock_timestamp() AS observed_at')
				).rows[0]!.observed_at;
				const repaired = await client.query<{
					id: string;
					expires_at: Date;
					idempotency_key: string | null;
					create_request_hash: string | null;
				}>(
					`SELECT id, expires_at, idempotency_key, create_request_hash
					 FROM volumes ORDER BY id`
				);
				expect(
					repaired.rows.map(({ id, idempotency_key, create_request_hash }) => ({
						id,
						idempotency_key,
						create_request_hash
					}))
				).toEqual([
					{
						id: 'vol_legacy_expiry_one',
						idempotency_key: null,
						create_request_hash: null
					},
					{
						id: 'vol_legacy_expiry_two',
						idempotency_key: null,
						create_request_hash: null
					}
				]);
				for (const row of repaired.rows) {
					expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(
						migrationStarted.getTime() + 30 * 24 * 60 * 60 * 1_000
					);
					expect(row.expires_at.getTime()).toBeLessThanOrEqual(
						migrationFinished.getTime() + 30 * 24 * 60 * 60 * 1_000
					);
				}
				const expiryColumn = await client.query<{ is_nullable: string }>(
					`SELECT is_nullable FROM information_schema.columns
					 WHERE table_schema = $1 AND table_name = 'volumes' AND column_name = 'expires_at'`,
					[schema]
				);
				expect(expiryColumn.rows[0]?.is_nullable).toBe('NO');

				await client.query('SAVEPOINT invalid_identity');
				let identityRejected = false;
				try {
					await client.query(
						`INSERT INTO volumes
						 (id, organization_id, project_id, object_prefix, size_limit_bytes,
						  created_at, expires_at, idempotency_key, create_request_hash)
						 VALUES ('vol_invalid_identity', $1, $2, 'legacy/invalid/', 1024,
						         $3, $3 + interval '1 day', 'half-present', NULL)`,
						[organizationId, projectId, createdAt]
					);
				} catch {
					identityRejected = true;
					await client.query('ROLLBACK TO SAVEPOINT invalid_identity');
				}
				expect(identityRejected).toBe(true);
				await client.query('RELEASE SAVEPOINT invalid_identity');
			} finally {
				await client.query('SET LOCAL search_path TO public');
				await client.query(`DROP SCHEMA "${schema}" CASCADE`);
			}
		});
	});
});
