import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('API-key allocation bounds migration', () => {
	it('serializes and bounds active and retained keys at organization and project scope', async () => {
		const sql = await readFile(
			new URL('../../src/db/migrations/0032_api_key_allocation_bounds.sql', import.meta.url),
			'utf8'
		);
		expect(sql).toContain('CREATE FUNCTION enforce_api_key_allocation_bounds()');
		expect(sql).toContain('FOR UPDATE');
		expect(sql).toContain('organization_active >= 64');
		expect(sql).toContain('project_active >= 16');
		expect(sql).toContain('organization_retained >= 4096');
		expect(sql).toContain('project_retained >= 1024');
		expect(sql).toContain('CREATE TRIGGER api_keys_allocation_bounds');
	});
});
