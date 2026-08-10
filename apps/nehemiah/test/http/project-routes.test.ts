import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyService } from '../../src/auth/api-key.js';
import type { AuditService } from '../../src/audit/audit.js';
import type { OrganizationService } from '../../src/domain/organizations.js';
import {
	ProjectQuotaExceeded,
	ProjectSlugConflict,
	type Project,
	type ProjectService
} from '../../src/domain/projects.js';
import { Router } from '../../src/http/router.js';
import {
	registerOrganizationRoutes,
	type OrganizationRouteServices
} from '../../src/http/routes/organizations.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const project: Project = {
	id: '22222222-2222-4222-8222-222222222222',
	organization_id: organizationId,
	slug: 'bounded-project',
	name: 'Bounded project',
	max_machines: 10,
	max_vcpus: 20,
	max_memory_mb: 20_480,
	max_disk_mb: 102_400,
	max_storage_mb: 102_400
};

const fixture = (
	create: ProjectService['create']
): { readonly create: ReturnType<typeof vi.fn>; readonly handle: () => Promise<Response> } => {
	const createSpy = vi.fn(create);
	const services = {
		apiKeys: { authenticate: async () => undefined } as unknown as ApiKeyService,
		audit: {
			capture: async <T>(_input: unknown, operation: () => Promise<T>) => operation()
		} as AuditService,
		organizations: {
			membershipRole: async () => 'admin'
		} as unknown as OrganizationService,
		clerkSessionVerifier: async () => ({ sub: 'clerk-project-admin', org_id: organizationId }),
		projects: {
			create: createSpy,
			list: async () => []
		} as unknown as ProjectService
	} satisfies OrganizationRouteServices;
	const router = new Router<OrganizationRouteServices>();
	registerOrganizationRoutes(router);
	return {
		create: createSpy,
		handle: () =>
			router.handle(
				new Request('https://api.example.test/v1/projects', {
					method: 'POST',
					headers: {
						authorization: 'Bearer clerk-session',
						'content-type': 'application/json'
					},
					body: JSON.stringify({ slug: project.slug, name: `  ${project.name}  ` })
				}),
				services
			)
	};
};

describe('project creation route outcomes', () => {
	it.each([
		{ replayed: false, status: 201 },
		{ replayed: true, status: 200 }
	])('returns $status when replayed=$replayed', async ({ replayed, status }) => {
		const target = fixture(async () => ({ project, replayed }));

		const response = await target.handle();

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual(project);
		expect(target.create).toHaveBeenCalledWith({
			organizationId,
			slug: project.slug,
			name: `  ${project.name}  `
		});
	});

	it.each([
		{
			error: new ProjectQuotaExceeded('The project limit was reached.'),
			status: 429,
			code: 'project_quota_exceeded'
		},
		{
			error: new ProjectSlugConflict('The slug conflicts with another name.'),
			status: 409,
			code: 'project_slug_conflict'
		}
	])('returns typed $status $code failures', async ({ error, status, code }) => {
		const target = fixture(async () => {
			throw error;
		});

		const response = await target.handle();

		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ title: code, status });
		if (status === 429) expect(response.headers.get('retry-after')).toBe('86400');
	});
});
