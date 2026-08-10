import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('extend operation migration', () => {
	it('persists an immutable target and a completed absolute expiry per key', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0006_extend_operations.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('CREATE TABLE machine_extend_operations');
		expect(migration).toContain('target_expires_at timestamptz NOT NULL');
		expect(migration).toContain('result_expires_at timestamptz');
		expect(migration).toContain('UNIQUE (organization_id, machine_id, idempotency_key)');
		expect(migration).toContain('result_expires_at >= target_expires_at');
		expect(migration).toContain('machine_extend_operation_identity_immutable');
	});
});
