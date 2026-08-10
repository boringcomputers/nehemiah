import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('device authorization migration', () => {
	it('stores only fixed-size token digests and enforces tenant-bound refresh families', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0014_device_authorization.sql', import.meta.url),
			'utf8'
		);

		for (const table of [
			'device_authorizations',
			'device_authorization_rate_limits',
			'device_refresh_families',
			'device_refresh_tokens',
			'device_access_tokens'
		]) {
			expect(migration).toContain(`CREATE TABLE ${table}`);
		}
		expect(migration).not.toMatch(
			/device_code\s+text|user_code\s+text|refresh_token\s+text|access_token\s+text/
		);
		expect(migration.match(/octet_length\([^)]*hash\) = 32/g)?.length).toBeGreaterThanOrEqual(5);
		expect(migration).toContain('FOREIGN KEY (project_id, organization_id)');
		expect(migration).toContain("status IN ('pending', 'approved', 'denied', 'consumed')");
	});

	it('places a hard ceiling on each refresh family and indexes expired credentials', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0027_device_refresh_bounds.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('generation BETWEEN 0 AND 4095');
		expect(migration).toContain('device_refresh_tokens_expired_retention_idx');
		expect(migration).toContain('device_access_tokens_expired_retention_idx');
	});

	it('serializes global retained-row ceilings and accounts every insert and delete', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0034_device_authorization_retention.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('CREATE TABLE device_retention_capacity');
		for (const constraint of [
			'device_retention_authorization_capacity',
			'device_retention_family_capacity',
			'device_retention_refresh_capacity',
			'device_retention_access_capacity'
		]) {
			expect(migration).toContain(constraint);
		}
		for (const table of [
			'device_authorizations',
			'device_refresh_families',
			'device_refresh_tokens',
			'device_access_tokens'
		]) {
			expect(migration).toContain(`BEFORE INSERT ON ${table}`);
			expect(migration).toContain(`AFTER DELETE ON ${table}`);
		}
		expect(migration).toContain('SECURITY DEFINER');
		expect(migration).toContain('REVOKE ALL ON FUNCTION account_device_retained_row() FROM PUBLIC');
	});
});
