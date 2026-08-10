import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';
import {
	ProjectQuotaExceeded,
	ProjectService,
	ProjectSlugConflict
} from '../../src/domain/projects.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('PostgreSQL retained project allocation bound', () => {
	let databaseA: Database;
	let databaseB: Database;

	beforeAll(() => {
		databaseA = new Database(databaseUrl!);
		databaseB = new Database(databaseUrl!);
	});

	afterAll(async () => {
		await databaseA?.close();
		await databaseB?.close();
	});

	it('serializes the final slot and preserves slug replay while rejecting every bypass', async () => {
		const organizationId = randomUUID();
		const zeroLimitOrganizationId = randomUUID();
		const suffix = randomUUID().replaceAll('-', '');
		const serviceA = new ProjectService(databaseA);
		const serviceB = new ProjectService(databaseB);

		try {
			await databaseA.query(
				`INSERT INTO organizations (id, slug, name, max_projects)
				 VALUES ($1, $2, 'Project allocation test', 2),
				        ($3, $4, 'Zero project allocation test', 0)`,
				[
					organizationId,
					`project-bound-${suffix}`,
					zeroLimitOrganizationId,
					`project-zero-${suffix}`
				]
			);

			const seeded = await serviceA.create({
				organizationId,
				slug: `seed-${suffix}`,
				name: 'Seed project'
			});
			expect(seeded.replayed).toBe(false);

			const attempts = await Promise.allSettled([
				serviceA.create({
					organizationId,
					slug: `final-a-${suffix}`,
					name: 'Final project A'
				}),
				serviceB.create({
					organizationId,
					slug: `final-b-${suffix}`,
					name: 'Final project B'
				})
			]);
			const fulfilled = attempts.filter(
				(result): result is PromiseFulfilledResult<Awaited<ReturnType<ProjectService['create']>>> =>
					result.status === 'fulfilled'
			);
			expect(fulfilled).toHaveLength(1);
			expect(fulfilled[0]!.value.replayed).toBe(false);
			expect(attempts.find(({ status }) => status === 'rejected')).toMatchObject({
				status: 'rejected',
				reason: expect.objectContaining({
					code: 'project_quota_exceeded',
					status: 429
				})
			});

			const projects = await serviceA.list(organizationId);
			expect(projects).toHaveLength(2);
			const accepted = fulfilled[0]!.value.project;
			expect(projects.map(({ id }) => id)).toEqual(
				expect.arrayContaining([seeded.project.id, accepted.id])
			);

			const replay = await serviceB.create({
				organizationId,
				slug: accepted.slug,
				name: `  ${accepted.name}  `
			});
			expect(replay).toEqual({ project: accepted, replayed: true });
			await expect(
				serviceA.create({
					organizationId,
					slug: accepted.slug,
					name: 'A different normalized name'
				})
			).rejects.toMatchObject({
				code: 'project_slug_conflict',
				status: 409
			} satisfies Partial<ProjectSlugConflict>);

			await expect(
				databaseA.query(
					`INSERT INTO projects (id, organization_id, slug, name)
					 VALUES ($1, $2, $3, 'Direct bypass')`,
					[randomUUID(), organizationId, `direct-${suffix}`]
				)
			).rejects.toMatchObject({
				code: '23514',
				constraint: 'projects_organization_retained_quota'
			});
			await expect(
				databaseA.query('UPDATE organizations SET max_projects = 1 WHERE id = $1', [organizationId])
			).rejects.toMatchObject({
				code: '23514',
				constraint: 'organizations_max_projects_below_retained'
			});

			await expect(
				serviceA.create({
					organizationId: zeroLimitOrganizationId,
					slug: `zero-${suffix}`,
					name: 'Not admitted'
				})
			).rejects.toBeInstanceOf(ProjectQuotaExceeded);
			await expect(
				databaseA.query('UPDATE projects SET organization_id = $1 WHERE id = $2', [
					zeroLimitOrganizationId,
					accepted.id
				])
			).rejects.toMatchObject({
				code: '23514',
				constraint: 'projects_organization_retained_quota'
			});
		} finally {
			await databaseA.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
				[organizationId, zeroLimitOrganizationId]
			]);
		}
	});
});
