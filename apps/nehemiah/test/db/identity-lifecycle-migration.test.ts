import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('identity lifecycle migration', () => {
	it('adds authoritative disable state and database-level credential containment', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0022_identity_lifecycle.sql', import.meta.url),
			'utf8'
		);

		for (const table of ['users', 'organizations', 'api_keys']) {
			expect(migration).toMatch(
				new RegExp(`ALTER TABLE ${table}\\s+[\\s\\S]*?ADD COLUMN disabled_at timestamptz`)
			);
		}
		for (const trigger of [
			'api_keys_revoke_dependents',
			'users_revoke_dependents',
			'organizations_revoke_dependents',
			'organization_members_revoke_dependents'
		]) {
			expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
		}
		expect(migration).toContain("issuer_type = 'api_key'");
		expect(migration).toContain("grant_record.issuer_type = 'clerk_user'");
		expect(migration).toContain("grant_record.issuer_type = 'device_family'");
		expect(migration).toContain('UPDATE device_refresh_families');
		expect(migration).toContain('UPDATE device_access_tokens');
		expect(migration).toContain('AFTER DELETE ON organization_members');
	});
});
