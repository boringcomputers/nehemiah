import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('managed host lifecycle migration', () => {
	it('adds operator authority and fail-closed credential state', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0005_host_lifecycle.sql', import.meta.url),
			'utf8'
		);

		expect(sql).toContain(
			"host_desired_state AS ENUM ('active', 'draining', 'quarantined', 'revoked')"
		);
		expect(sql).toContain("host_credential_status AS ENUM ('active', 'revoked')");
		expect(sql).toContain('credential_generation integer NOT NULL DEFAULT 1');
		expect(sql).toContain('enrollment_completed_at timestamptz');
		expect(sql).toContain('host_heartbeats_credential_generation_positive');
		expect(sql).toContain('hosts_credential_material_matches_status');
		expect(sql).toContain('CREATE TABLE fleet_operator_organizations');
		expect(sql).toContain('credential_hash DROP NOT NULL');
	});
});
