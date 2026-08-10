import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { expectedDatabaseMigration } from '../../src/db/client.js';

describe('initial PostgreSQL schema', () => {
	it('contains every control-plane aggregate and immutable ledgers', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0001_initial.sql', import.meta.url),
			'utf8'
		);
		for (const table of [
			'users',
			'organizations',
			'organization_members',
			'projects',
			'api_keys',
			'regions',
			'hosts',
			'host_heartbeats',
			'machines',
			'machine_events',
			'idempotency_keys',
			'templates',
			'template_replicas',
			'volumes',
			'usage_events',
			'usage_outbox',
			'usage_daily',
			'billing_accounts',
			'stripe_events',
			'audit_events'
		]) {
			expect(sql).toContain(`CREATE TABLE ${table}`);
		}
		expect(sql.match(/reject_append_only_mutation/g)?.length).toBeGreaterThanOrEqual(4);
		expect(sql).toContain("key_hash text NOT NULL CHECK (key_hash LIKE '$argon2id$%')");
	});
});

describe('database readiness contract', () => {
	it('always names the lexicographically latest additive migration', async () => {
		const migrations = (await readdir(new URL('../../src/db/migrations/', import.meta.url)))
			.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
			.sort();
		expect(migrations.length).toBeGreaterThan(0);
		expect(expectedDatabaseMigration.name).toBe(migrations.at(-1));
	});

	it('pins readiness to the exact latest migration bytes', async () => {
		const sql = await readFile(
			new URL(`../../src/db/migrations/${expectedDatabaseMigration.name}`, import.meta.url),
			'utf8'
		);
		expect(createHash('sha256').update(sql).digest('hex')).toBe(expectedDatabaseMigration.checksum);
	});
});
