import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project disk quota migration', () => {
	it('splits machine disk from managed-volume storage without changing existing limits', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0020_project_machine_disk_quotas.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('ADD COLUMN max_disk_mb bigint');
		expect(migration).toContain('SET max_disk_mb = max_storage_mb');
		expect(migration).toContain('projects_max_disk_mb_json_safe');
		expect(migration).toContain('projects_max_storage_mb_json_safe');
		expect(migration.match(/9007199254740991/g)).toHaveLength(2);
		expect(migration).toContain('Maximum durable managed-volume allocation');
		expect(migration).toContain('Maximum active machine disk reservation');
	});
});
