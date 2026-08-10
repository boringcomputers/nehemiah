import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { ProjectAllocationIntegrityError, ProjectService } from '../../src/domain/projects.js';

const projectRow = (index: number, maximum: number, retained: number) => ({
	id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
	organization_id: '11111111-1111-4111-8111-111111111111',
	slug: `project-${index}`,
	name: `Project ${index}`,
	max_machines: 10,
	max_vcpus: 20,
	max_memory_mb: 20_480,
	max_disk_mb: '102400',
	max_storage_mb: '102400',
	organization_max_projects: maximum,
	organization_project_count: retained
});

describe('project list allocation boundary', () => {
	it('strips internal allocation fields from a list within the configured bound', async () => {
		const query = vi.fn().mockResolvedValue({
			rows: Array.from({ length: 16 }, (_, index) => projectRow(index, 16, 16))
		});
		const service = new ProjectService({ query } as unknown as Database);

		const projects = await service.list('11111111-1111-4111-8111-111111111111');

		expect(projects).toHaveLength(16);
		expect(projects[0]).not.toHaveProperty('organization_max_projects');
		expect(projects[0]).not.toHaveProperty('organization_project_count');
		expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $3'), [
			'11111111-1111-4111-8111-111111111111',
			null,
			65
		]);
	});

	it.each([
		{ returned: 17, maximum: 16, retained: 17 },
		{ returned: 65, maximum: 64, retained: 65 },
		{ returned: 1, maximum: 65, retained: 1 }
	])('fails closed for invalid allocation state %#', async ({ returned, maximum, retained }) => {
		const database = {
			query: vi.fn().mockResolvedValue({
				rows: Array.from({ length: returned }, (_, index) => projectRow(index, maximum, retained))
			})
		} as unknown as Database;

		await expect(
			new ProjectService(database).list('11111111-1111-4111-8111-111111111111')
		).rejects.toBeInstanceOf(ProjectAllocationIntegrityError);
	});
});
