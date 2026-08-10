import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	ApiKeyQuotaExceeded,
	PostgresApiKeyStore,
	type ApiKeyRecord
} from '../../src/auth/api-key.js';
import { Database } from '../../src/db/client.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const record = (
	organizationId: string,
	projectId: string | undefined,
	label: string
): ApiKeyRecord => ({
	id: randomUUID(),
	organizationId,
	projectId,
	name: label,
	prefix: `quota-${label}-${randomUUID()}`,
	keyHash: '$argon2id$bounded-test-record',
	scopes: ['machines:read']
});

databaseDescribe('PostgreSQL API-key allocation bounds', () => {
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

	it('serializes concurrent project and organization allocation and keeps rotation neutral', async () => {
		const projectOrganizationId = randomUUID();
		const projectId = randomUUID();
		const suffix = randomUUID().replaceAll('-', '');
		await databaseA.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'API key project quota')`,
			[projectOrganizationId, `key-project-${suffix}`]
		);
		await databaseA.query(
			`INSERT INTO projects (id, organization_id, slug, name)
			 VALUES ($1, $2, $3, 'API key quota project')`,
			[projectId, projectOrganizationId, `key-project-${suffix}`]
		);
		await databaseA.query(
			`INSERT INTO api_keys
			 (id, organization_id, project_id, name, prefix, key_hash, scopes)
			 SELECT gen_random_uuid(), $1, $2, 'seed-' || value,
			        $3 || value, '$argon2id$seed', ARRAY['machines:read']
			 FROM generate_series(1, 15) AS value`,
			[projectOrganizationId, projectId, `quota-${suffix}-project-`]
		);

		const projectAttempts = await Promise.allSettled([
			new PostgresApiKeyStore(databaseA).insert(
				record(projectOrganizationId, projectId, 'project-a')
			),
			new PostgresApiKeyStore(databaseB).insert(
				record(projectOrganizationId, projectId, 'project-b')
			)
		]);
		expect(projectAttempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		const projectRejection = projectAttempts.find(({ status }) => status === 'rejected');
		expect(projectRejection).toMatchObject({
			status: 'rejected',
			reason: expect.any(ApiKeyQuotaExceeded)
		});

		const source = await databaseA.query<{ id: string }>(
			`SELECT id FROM api_keys
			 WHERE organization_id = $1 AND project_id = $2 AND revoked_at IS NULL
			 ORDER BY created_at, id LIMIT 1`,
			[projectOrganizationId, projectId]
		);
		const replacement = record(projectOrganizationId, projectId, 'rotation');
		expect(
			await new PostgresApiKeyStore(databaseA).rotate(source.rows[0]!.id, projectOrganizationId, {
				id: replacement.id,
				prefix: replacement.prefix,
				keyHash: replacement.keyHash
			})
		).toBe(true);
		const projectCounts = await databaseA.query<{ active: string; retained: string }>(
			`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::text AS active,
			        count(*)::text AS retained
			 FROM api_keys WHERE organization_id = $1 AND project_id = $2`,
			[projectOrganizationId, projectId]
		);
		expect(projectCounts.rows[0]).toEqual({ active: '16', retained: '17' });

		const organizationId = randomUUID();
		await databaseA.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'API key organization quota')`,
			[organizationId, `key-org-${suffix}`]
		);
		await databaseA.query(
			`INSERT INTO api_keys (id, organization_id, name, prefix, key_hash, scopes)
			 SELECT gen_random_uuid(), $1, 'seed-' || value,
			        $2 || value, '$argon2id$seed', ARRAY['machines:read']
			 FROM generate_series(1, 63) AS value`,
			[organizationId, `quota-${suffix}-organization-`]
		);
		const organizationAttempts = await Promise.allSettled([
			new PostgresApiKeyStore(databaseA).insert(record(organizationId, undefined, 'org-a')),
			new PostgresApiKeyStore(databaseB).insert(record(organizationId, undefined, 'org-b'))
		]);
		expect(organizationAttempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(organizationAttempts.find(({ status }) => status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: expect.any(ApiKeyQuotaExceeded)
		});
		const organizationCount = await databaseA.query<{ active: string }>(
			`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::text AS active
			 FROM api_keys WHERE organization_id = $1`,
			[organizationId]
		);
		expect(organizationCount.rows[0]?.active).toBe('64');
	});
});
