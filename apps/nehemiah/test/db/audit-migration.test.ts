import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('audit operation migration', () => {
	it('adds tenant-qualified correlated outcomes to the append-only ledger', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0003_audit_operations.sql', import.meta.url),
			'utf8'
		);

		expect(sql).toContain('operation_id uuid NOT NULL');
		expect(sql).toContain('project_id uuid');
		expect(sql).toContain("'requested', 'succeeded', 'failed', 'denied'");
		expect(sql).toContain('FOREIGN KEY (project_id, organization_id)');
		expect(sql).toContain('audit_events_operation_idx');
	});
});
