import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('fork terminal hardening migration', () => {
	it('persists cleanup intent, claim ownership, and the logical audit identity', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0010_fork_terminal_hardening.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('audit_operation_id uuid');
		expect(migration).toContain('cleanup_requested_at timestamptz');
		expect(migration).toContain('cleanup_claim_token uuid');
		expect(migration).toContain('machine_fork_cleanup_decision_check');
		expect(migration).toContain('machine_fork_cleanup_claim_check');
		expect(migration).toContain('machine_fork_audit_identity_immutable');
	});
});
