import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('fork operation migration', () => {
	it('stores immutable operation and child identities with bounded all-or-cleanup state', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0007_fork_operations.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('CREATE TABLE machine_fork_operations');
		expect(migration).toContain('child_count BETWEEN 1 AND 8');
		expect(migration).toContain('source_host_machine_id text NOT NULL');
		expect(migration).toContain('source_lease_id uuid NOT NULL');
		expect(migration).toContain('machines_host_lease_identity_unique');
		expect(migration).toContain('CREATE TABLE machine_fork_children');
		expect(migration).toContain('machine_fork_operation_identity_immutable');
		expect(migration).toContain('machine_fork_child_identity_immutable');
	});
});
