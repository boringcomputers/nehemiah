import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('gateway capability revocation migration', () => {
	it('generalizes every jti into an immutable issuer-bound revocable grant', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0019_gateway_capability_revocation.sql', import.meta.url),
			'utf8'
		);
		for (const binding of [
			'capabilities text[]',
			'issuer_type text',
			'issuer_id text',
			'revoked_at timestamptz',
			'machine_gateway_grants_port_check',
			'machine_gateway_grants_active_issuer_idx',
			'machine_gateway_grant_identity_immutable'
		]) {
			expect(migration).toContain(binding);
		}
		expect(migration).toContain(
			"issuer_type IN ('api_key', 'clerk_user', 'device_family', 'legacy')"
		);
		expect(migration).toContain("(port IS NOT NULL) = ('preview' = ANY(capabilities))");
		expect(migration).toContain("issuer_type = 'legacy'");
		expect(migration).toContain('revoked_at = COALESCE(revoked_at, statement_timestamp())');
	});
});
