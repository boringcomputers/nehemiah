import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('project allocation-bound migration', () => {
	it('bounds existing, new, moved, and limit-lowered project state', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0035_project_allocation_bounds.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('HAVING count(*) > 64');
		expect(migration).toContain('ADD COLUMN max_projects integer NOT NULL DEFAULT 16');
		expect(migration).toContain('CHECK (max_projects BETWEEN 0 AND 64)');
		expect(migration).toContain('SET max_projects = GREATEST(');
		expect(migration).toContain('CREATE FUNCTION enforce_project_allocation_bound()');
		expect(migration).toContain('FOR UPDATE');
		expect(migration).toContain('projects_allocation_bound_insert');
		expect(migration).toContain('projects_allocation_bound_move');
		expect(migration).toContain("CONSTRAINT = 'projects_organization_retained_quota'");
		expect(migration).toContain('CREATE FUNCTION enforce_organization_project_limit_update()');
		expect(migration).toContain('organizations_project_limit_update');
		expect(migration).toContain("CONSTRAINT = 'organizations_max_projects_below_retained'");
	});
});
