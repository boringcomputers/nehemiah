import { randomUUID } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresApiAdmission, type ApiRateLimitConfig } from '../../src/auth/api-admission.js';
import { ApiKeyService, PostgresApiKeyStore } from '../../src/auth/api-key.js';
import { AuditService } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { authenticate, type AuthServices } from '../../src/http/auth.js';
import { json, problem, Router } from '../../src/http/router.js';
import { listenRouter, type TestHttpServer } from '../helpers/http-server.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('real HTTP + PostgreSQL API admission', () => {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const suffix = randomUUID().replaceAll('-', '');
	let databaseA: Database;
	let databaseB: Database;
	let httpA: TestHttpServer;
	let httpB: TestHttpServer;
	let apiKey: string;

	const rateConfig: ApiRateLimitConfig = {
		enabled: true,
		windowSeconds: 60,
		preAuthIpRequests: 100,
		preAuthApiKeyRequests: 100,
		principalRequests: 4,
		organizationRequests: 100,
		projectRequests: 100,
		failClosed: true
	};

	const server = async (
		database: Database,
		admissionConfig: ApiRateLimitConfig = rateConfig,
		verifySecret?: (encoded: string, raw: string) => Promise<boolean>
	): Promise<TestHttpServer> => {
		const services: AuthServices = {
			apiKeys: new ApiKeyService(new PostgresApiKeyStore(database), 'test', { verifySecret }),
			apiAdmission: new PostgresApiAdmission(database, admissionConfig),
			audit: new AuditService(database),
			organizations: new OrganizationService(database)
		};
		const router = new Router<AuthServices>();
		router.get('/v1/admission-probe', async ({ request, services, requestId }) => {
			const principal = await authenticate(request, services);
			return principal
				? json({ organization_id: principal.organizationId })
				: problem(401, 'unauthorized', 'A valid API key is required.', requestId);
		});
		return listenRouter(router, services);
	};

	beforeAll(async () => {
		databaseA = new Database(databaseUrl!);
		databaseB = new Database(databaseUrl!);
		await databaseA.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Admission test')`,
			[organizationId, `admission-${suffix}`]
		);
		await databaseA.query(
			`INSERT INTO projects (id, organization_id, slug, name)
			 VALUES ($1, $2, $3, 'Admission project')`,
			[projectId, organizationId, `admission-${suffix}`]
		);
		const created = await new ApiKeyService(new PostgresApiKeyStore(databaseA), 'test').create({
			organizationId,
			projectId,
			name: 'Concurrent admission probe',
			scopes: ['machines:read']
		});
		apiKey = created.key;
		httpA = await server(databaseA);
		httpB = await server(databaseB);
	});

	afterAll(async () => {
		await httpA?.close();
		await httpB?.close();
		// API-key creation writes the append-only audit ledger. Integration
		// databases are disposable; never weaken or mutate that ledger for cleanup.
		await databaseA?.close();
		await databaseB?.close();
	});

	it('enforces one authoritative principal window across concurrent replicas', async () => {
		const responses = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				fetch(`${index % 2 ? httpA.origin : httpB.origin}/v1/admission-probe`, {
					headers: {
						authorization: `Bearer ${apiKey}`,
						'x-nehemiah-client-address': '203.0.113.42'
					}
				})
			)
		);
		const accepted = responses.filter(({ status }) => status === 200);
		const limited = responses.filter(({ status }) => status === 429);
		expect(accepted).toHaveLength(4);
		expect(limited).toHaveLength(8);
		for (const response of limited) {
			expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
			expect(await response.json()).toMatchObject({ title: 'rate_limit_exceeded' });
		}
		expect(responses.some(({ status }) => status >= 500)).toBe(false);

		const stored = await databaseA.query<{
			scope: string;
			request_count: number;
		}>(
			`SELECT scope, request_count FROM api_admission_windows
			 WHERE scope IN ('principal', 'organization', 'project')
			 ORDER BY scope`
		);
		expect(
			stored.rows.some(({ scope, request_count }) => scope === 'principal' && request_count >= 12)
		).toBe(true);
	});

	it('globally rejects a forged public-prefix/source pair before authentication work', async () => {
		const preAuthConfig: ApiRateLimitConfig = {
			...rateConfig,
			preAuthApiKeyRequests: 3,
			principalRequests: 100
		};
		const replicaA = await server(databaseA, preAuthConfig);
		const replicaB = await server(databaseB, preAuthConfig);
		try {
			const forged = `bc_test_${suffix.slice(0, 12)}_${'Z'.repeat(43)}`;
			const responses = await Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					fetch(`${index % 2 ? replicaA.origin : replicaB.origin}/v1/admission-probe`, {
						headers: {
							authorization: `Bearer ${forged}`,
							'x-nehemiah-client-address': '198.51.100.78'
						}
					})
				)
			);
			expect(responses.filter(({ status }) => status === 401)).toHaveLength(3);
			expect(responses.filter(({ status }) => status === 429)).toHaveLength(7);
			expect(responses.some(({ status }) => status >= 500)).toBe(false);
			for (const response of responses) await response.body?.cancel();
		} finally {
			await replicaA.close();
			await replicaB.close();
		}
	});

	it('globally bounds one valid key before Argon across distinct source networks and replicas', async () => {
		const credential = await new ApiKeyService(new PostgresApiKeyStore(databaseA), 'test').create({
			organizationId,
			projectId,
			name: 'Distributed verifier admission probe',
			scopes: ['machines:read']
		});
		const preAuthConfig: ApiRateLimitConfig = {
			...rateConfig,
			preAuthIpRequests: 100,
			preAuthApiKeyRequests: 3,
			principalRequests: 100
		};
		let verifications = 0;
		const countedVerify = async (encoded: string, raw: string): Promise<boolean> => {
			verifications += 1;
			return verify(encoded, raw);
		};
		const replicaA = await server(databaseA, preAuthConfig, countedVerify);
		const replicaB = await server(databaseB, preAuthConfig, countedVerify);
		try {
			const responses = await Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					fetch(`${index % 2 ? replicaA.origin : replicaB.origin}/v1/admission-probe`, {
						headers: {
							authorization: `Bearer ${credential.key}`,
							'x-nehemiah-client-address': `198.51.${index}.7`
						}
					})
				)
			);
			expect(responses.filter(({ status }) => status === 200)).toHaveLength(3);
			expect(responses.filter(({ status }) => status === 429)).toHaveLength(7);
			expect(responses.some(({ status }) => status >= 500)).toBe(false);
			expect(verifications).toBe(3);
			for (const response of responses) await response.body?.cancel();
		} finally {
			await replicaA.close();
			await replicaB.close();
		}
	});
});
