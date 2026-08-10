import { randomBytes, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, type Queryable } from '../../src/db/client.js';
import { applyRuntimeRolePrivileges } from '../../src/db/roles.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = databaseUrl && process.env.NEHEMIAH_DB_ROLE_TEST === '1';
const databaseDescribe = enabled ? describe : describe.skip;

databaseDescribe('runtime PostgreSQL role boundary', () => {
	const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
	const role = `neh_runtime_test_${suffix}`;
	const password = randomBytes(24).toString('hex');
	const region = `role-test-${suffix}`;
	const eventKey = `role-test:${suffix}`;
	let owner: Database;
	let runtime: Queryable;

	beforeAll(async () => {
		owner = new Database(databaseUrl!);
		await owner.query(
			`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
		);
		await applyRuntimeRolePrivileges(owner, role);
		// SET LOCAL ROLE exercises PostgreSQL's real privilege engine without
		// coupling the test to a particular CI pg_hba password/peer policy.
		runtime = {
			async query<R extends QueryResultRow = QueryResultRow>(
				text: string,
				values: ReadonlyArray<unknown> = []
			) {
				return owner.transaction(async (client) => {
					await client.query(`SET LOCAL ROLE "${role}"`);
					return client.query<R>(text, [...values]);
				});
			}
		};
	});

	afterAll(async () => {
		if (owner) {
			await owner.query('DELETE FROM regions WHERE id = $1', [region]);
			// The append-only audit fixture is intentionally retained. Requiring a
			// superuser-only trigger bypass merely to clean a test would weaken the
			// exact non-owner migration/runtime topology this suite is proving. CI
			// runs this test in a disposable database that is dropped afterward.
			await owner.query(`DROP OWNED BY "${role}"`);
			await owner.query(`DROP ROLE IF EXISTS "${role}"`);
			await owner.close();
		}
	});

	it('permits ordinary DML but denies ledger mutation, migration tampering, and DDL', async () => {
		await runtime.query('INSERT INTO regions (id, provider, display_name) VALUES ($1, $2, $3)', [
			region,
			'test',
			'Runtime role test'
		]);
		await runtime.query('UPDATE regions SET display_name = $2 WHERE id = $1', [
			region,
			'Runtime role updated'
		]);
		await runtime.query(
			`INSERT INTO audit_events (event_key, actor_type, action, metadata)
			 VALUES ($1, 'system', 'runtime_role.test', '{}'::jsonb)`,
			[eventKey]
		);
		const meteringPrivileges = await runtime.query<{
			observations_insert: boolean;
			raw_insert: boolean;
			exceptions_insert: boolean;
			resolutions_insert: boolean;
			sync_receipts_insert: boolean;
		}>(`SELECT
		  has_table_privilege(current_user, 'host_usage_observations', 'INSERT') AS observations_insert,
		  has_table_privilege(current_user, 'meter_raw_usage_events', 'INSERT') AS raw_insert,
		  has_table_privilege(current_user, 'metering_exceptions', 'INSERT') AS exceptions_insert,
		  has_table_privilege(current_user, 'metering_exception_resolutions', 'INSERT') AS resolutions_insert,
		  has_table_privilege(current_user, 'identity_provider_sync_receipts', 'INSERT') AS sync_receipts_insert`);
		expect(meteringPrivileges.rows[0]).toEqual({
			observations_insert: true,
			raw_insert: true,
			exceptions_insert: true,
			resolutions_insert: true,
			sync_receipts_insert: true
		});
		const deviceAuthorizationId = randomUUID();
		const counterBefore = await runtime.query<{ authorization_rows: string }>(
			'SELECT authorization_rows::text FROM device_retention_capacity WHERE singleton'
		);
		await runtime.query(
			`INSERT INTO device_authorizations
			 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
			  next_poll_at, created_at, expires_at)
			 VALUES ($1, decode(repeat('11', 32), 'hex'), decode(repeat('22', 32), 'hex'),
			         'nehemiah-cli', ARRAY['machines:read']::text[],
			         statement_timestamp() + interval '5 seconds', statement_timestamp(),
			         statement_timestamp() + interval '10 minutes')`,
			[deviceAuthorizationId]
		);
		const counterDuring = await runtime.query<{ authorization_rows: string }>(
			'SELECT authorization_rows::text FROM device_retention_capacity WHERE singleton'
		);
		expect(BigInt(counterDuring.rows[0]!.authorization_rows)).toBe(
			BigInt(counterBefore.rows[0]!.authorization_rows) + 1n
		);
		await runtime.query('DELETE FROM device_authorizations WHERE id = $1', [deviceAuthorizationId]);
		const counterAfter = await runtime.query<{ authorization_rows: string }>(
			'SELECT authorization_rows::text FROM device_retention_capacity WHERE singleton'
		);
		expect(counterAfter.rows[0]).toEqual(counterBefore.rows[0]);

		for (const statement of [
			`UPDATE audit_events SET action = 'tampered' WHERE event_key = '${eventKey}'`,
			`DELETE FROM audit_events WHERE event_key = '${eventKey}'`,
			'TRUNCATE audit_events',
			'UPDATE host_usage_observations SET sequence = sequence',
			'DELETE FROM meter_raw_usage_events',
			'TRUNCATE metering_exceptions',
			"UPDATE metering_exception_resolutions SET resolution = 'tampered'",
			'UPDATE identity_provider_sync_receipts SET changed = false',
			'UPDATE device_retention_capacity SET authorization_rows = 0',
			'DELETE FROM device_retention_capacity',
			'TRUNCATE device_retention_capacity',
			"UPDATE schema_migrations SET checksum = repeat('0', 64)",
			'ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only',
			'ALTER TABLE audit_events ADD COLUMN attacker text'
		]) {
			await expect(runtime.query(statement)).rejects.toMatchObject({ code: '42501' });
		}
	});
});
