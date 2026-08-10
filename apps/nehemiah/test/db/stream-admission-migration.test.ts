import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const canonicalOff = { mode: 'off', hostnames: [], cidrs: [] };
const legacyAllowlist = { mode: 'allowlist', hostnames: [], cidrs: ['203.0.113.0/24'] };

const migrationSql = async (): Promise<string> =>
	readFile(
		new URL(
			'../../src/db/migrations/0023_stream_admission_and_egress_boundary.sql',
			import.meta.url
		),
		'utf8'
	);

const requestAdmissionMigrationSql = async (): Promise<string> =>
	readFile(
		new URL(
			'../../src/db/migrations/0029_gateway_capability_request_admission.sql',
			import.meta.url
		),
		'utf8'
	);

describe('global stream admission migration', () => {
	it('declares simultaneous organization/project count and bandwidth limits', async () => {
		const sql = await migrationSql();
		expect(sql).toContain('CREATE TABLE gateway_stream_leases');
		expect(sql).toContain('max_gateway_streams integer NOT NULL DEFAULT 32');
		expect(sql).toContain('max_gateway_bandwidth_bps bigint NOT NULL DEFAULT 8388608');
		expect(sql).toContain('machines_nonterminal_egress_off_check');
		expect(sql).toContain("state IN ('stopped', 'failed', 'lost')");
	});

	it('uses only a fixed collision-conservative slot space for route-request admission', async () => {
		const sql = await requestAdmissionMigrationSql();
		expect(sql).toContain('CREATE TABLE gateway_capability_request_windows');
		expect(sql).toContain("scope IN ('authority', 'project', 'organization')");
		expect(sql).toContain('bucket_slot < 1048576');
		expect(sql).not.toContain('authority_id');
		expect(sql).not.toContain('organization_id');
	});
});

databaseDescribe('managed-egress rollout boundary', () => {
	it('rejects a legacy active allowlist before adding the durable off-only constraint', async () => {
		const sql = await migrationSql();
		const guardEnd = sql.indexOf('ALTER TABLE machines');
		const guard = sql.slice(0, guardEnd);
		const database = new Database(databaseUrl!);
		try {
			await expect(
				database.transaction(async (client) => {
					await client.query(
						'CREATE TEMP TABLE machines (state text, network_policy jsonb) ON COMMIT DROP'
					);
					await client.query('INSERT INTO machines VALUES ($1, $2)', [
						'running',
						JSON.stringify(legacyAllowlist)
					]);
					await client.query(guard);
				})
			).rejects.toThrow(/managed egress rollout requires/);
		} finally {
			await database.close();
		}
	});

	it('keeps terminal legacy rows readable while blocking every new nonterminal allowlist', async () => {
		const sql = await migrationSql();
		const constraint = sql.match(
			/ALTER TABLE machines\s+ADD CONSTRAINT machines_nonterminal_egress_off_check[\s\S]*?;\s*/
		)?.[0];
		expect(constraint).toBeTruthy();
		const database = new Database(databaseUrl!);
		try {
			await database.transaction(async (client) => {
				await client.query(
					'CREATE TEMP TABLE machines (state text, network_policy jsonb) ON COMMIT DROP'
				);
				await client.query(constraint!);
				await client.query('INSERT INTO machines VALUES ($1, $2), ($3, $4)', [
					'lost',
					JSON.stringify(legacyAllowlist),
					'running',
					JSON.stringify(canonicalOff)
				]);
				const rows = await client.query<{ state: string }>(
					'SELECT state FROM machines ORDER BY state'
				);
				expect(rows.rows.map((row) => row.state)).toEqual(['lost', 'running']);
			});
			await expect(
				database.transaction(async (client) => {
					await client.query(
						'CREATE TEMP TABLE machines (state text, network_policy jsonb) ON COMMIT DROP'
					);
					await client.query(constraint!);
					await client.query('INSERT INTO machines VALUES ($1, $2)', [
						'starting',
						JSON.stringify(legacyAllowlist)
					]);
				})
			).rejects.toThrow(/machines_nonterminal_egress_off_check/);
		} finally {
			await database.close();
		}
	});
});
