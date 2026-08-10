import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyService, PostgresApiKeyStore } from '../../src/auth/api-key.js';
import { PostgresApiAdmission, type ApiRateLimitConfig } from '../../src/auth/api-admission.js';
import { AuditService, auditUserAgentFingerprint } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { authenticate, type AuthServices } from '../../src/http/auth.js';
import { json, problem, Router } from '../../src/http/router.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('authentication audit PostgreSQL boundary', () => {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	const suffix = randomUUID().replaceAll('-', '');
	const hostileUserAgent = `Bearer bc_live_deadbeefcafe_${'S'.repeat(43)}`;
	let database: Database;
	let services: AuthServices;
	let router: Router<AuthServices>;
	let apiKey: string;

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.query(
			`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Authentication audit')`,
			[organizationId, `auth-audit-${suffix}`]
		);
		await database.query(
			`INSERT INTO projects (id, organization_id, slug, name)
			 VALUES ($1, $2, $3, 'Authentication audit project')`,
			[projectId, organizationId, `auth-audit-${suffix}`]
		);
		const audit = new AuditService(database);
		const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		apiKey = (
			await apiKeys.create({
				organizationId,
				projectId,
				name: 'Authentication audit key',
				scopes: ['machines:read'],
				requestId: randomUUID(),
				userAgent: hostileUserAgent
			})
		).key;
		services = {
			apiKeys,
			audit,
			organizations: new OrganizationService(database)
		};
		router = new Router<AuthServices>();
		router.get('/v1/audit-probe', async ({ request, services, requestId }) => {
			const principal = await authenticate(request, services);
			return principal
				? json({ organization_id: principal.organizationId })
				: problem(401, 'unauthorized', 'A valid credential is required.', requestId);
		});
		router.get('/v1/denied-probe', async ({ request, services, requestId }) => {
			const principal = await authenticate(request, services);
			return principal
				? problem(403, 'forbidden', 'The credential lacks permission.', requestId)
				: problem(401, 'unauthorized', 'A valid credential is required.', requestId);
		});
	});

	afterAll(async () => database?.close());

	const request = (path: string, credential: string): Request =>
		new Request(`https://api.example.test${path}`, {
			headers: {
				authorization: `Bearer ${credential}`,
				'user-agent': hostileUserAgent,
				'x-nehemiah-client-address': '203.0.113.44',
				'x-request-id': randomUUID()
			}
		});

	it('coalesces complete auth/authz outcomes without retaining credentials or raw headers', async () => {
		expect((await router.handle(request('/v1/audit-probe', apiKey), services)).status).toBe(200);
		expect((await router.handle(request('/v1/audit-probe', apiKey), services)).status).toBe(200);
		expect((await router.handle(request('/v1/denied-probe', apiKey), services)).status).toBe(403);
		const invalid = `bc_test_${suffix.slice(0, 12)}_${'Z'.repeat(43)}`;
		expect((await router.handle(request('/v1/audit-probe', invalid), services)).status).toBe(401);

		const events = await database.query<{
			action: string;
			outcome: string;
			user_agent: string | null;
			request_id: string | null;
		}>(
			`SELECT action, outcome, user_agent, request_id
			 FROM audit_events
			 WHERE organization_id = $1
			   AND (action LIKE 'authentication.%' OR action LIKE 'authorization.%'
			        OR action = 'api_key.created')
			 ORDER BY id`,
			[organizationId]
		);
		expect(events.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: 'authentication.api_key', outcome: 'succeeded' }),
				expect.objectContaining({ action: 'authorization.api_key', outcome: 'denied' })
			])
		);
		const denied = await database.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM audit_events
			 WHERE action = 'authentication.api_key' AND outcome = 'denied'`
		);
		expect(Number(denied.rows[0]?.count)).toBeGreaterThanOrEqual(1);
		for (const event of events.rows) {
			expect(event.user_agent).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/);
		}

		const counters = await database.query<{
			succeeded: string;
			denied: string;
		}>(
			`SELECT sum(succeeded_count)::text AS succeeded,
			        sum(denied_count)::text AS denied
			 FROM authentication_attempt_windows WHERE credential_kind = 'api_key'`
		);
		expect(Number(counters.rows[0]?.succeeded)).toBeGreaterThanOrEqual(3);
		expect(Number(counters.rows[0]?.denied)).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify({ events: events.rows, counters: counters.rows })).not.toContain(
			hostileUserAgent
		);
		expect(JSON.stringify(events.rows)).not.toContain(apiKey);
	});

	it('fingerprints even a direct writer that bypasses application normalization', async () => {
		const raw = `Cookie session=${'private'.repeat(20)}`;
		const eventKey = `raw-user-agent-defense:${randomUUID()}`;
		await database.query(
			`INSERT INTO audit_events
			 (event_key, actor_type, action, outcome, user_agent)
			 VALUES ($1, 'system', 'audit.trigger.test', 'denied', $2)`,
			[eventKey, raw]
		);
		const stored = await database.query<{ user_agent: string }>(
			'SELECT user_agent FROM audit_events WHERE event_key = $1',
			[eventKey]
		);
		expect(stored.rows[0]?.user_agent).toBe(auditUserAgentFingerprint(raw));
		expect(JSON.stringify(stored.rows)).not.toContain(raw);
	});

	it('durably records pre-auth and post-auth admission denials before returning 429', async () => {
		const limited = (
			credential: string,
			config: ApiRateLimitConfig
		): { router: Router<AuthServices>; services: AuthServices; credential: string } => {
			const limitedServices: AuthServices = {
				...services,
				apiAdmission: new PostgresApiAdmission(database, config)
			};
			const limitedRouter = new Router<AuthServices>();
			limitedRouter.get('/v1/limited-audit-probe', async ({ request, services, requestId }) => {
				const principal = await authenticate(request, services);
				return principal
					? json({ organization_id: principal.organizationId })
					: problem(401, 'unauthorized', 'A valid credential is required.', requestId);
			});
			return { router: limitedRouter, services: limitedServices, credential };
		};
		const base: ApiRateLimitConfig = {
			enabled: true,
			windowSeconds: 60,
			preAuthIpRequests: 100,
			preAuthApiKeyRequests: 100,
			principalRequests: 100,
			organizationRequests: 100,
			projectRequests: 100,
			failClosed: true
		};

		const preAuth = limited(apiKey, { ...base, preAuthApiKeyRequests: 1 });
		expect(
			(
				await preAuth.router.handle(
					request('/v1/limited-audit-probe', preAuth.credential),
					preAuth.services
				)
			).status
		).toBe(200);
		expect(
			(
				await preAuth.router.handle(
					request('/v1/limited-audit-probe', preAuth.credential),
					preAuth.services
				)
			).status
		).toBe(429);

		const postAuthCredential = (
			await services.apiKeys.create({
				organizationId,
				projectId,
				name: 'Post-auth admission audit key',
				scopes: ['machines:read']
			})
		).key;
		const postAuth = limited(postAuthCredential, { ...base, principalRequests: 1 });
		expect(
			(
				await postAuth.router.handle(
					request('/v1/limited-audit-probe', postAuth.credential),
					postAuth.services
				)
			).status
		).toBe(200);
		expect(
			(
				await postAuth.router.handle(
					request('/v1/limited-audit-probe', postAuth.credential),
					postAuth.services
				)
			).status
		).toBe(429);

		const denials = await database.query<{ reason_code: string }>(
			`SELECT reason_code FROM audit_events
			 WHERE action = 'authentication.api_key'
			   AND reason_code IN ('preauth_rate_limited', 'postauth_rate_limited')`
		);
		expect(new Set(denials.rows.map(({ reason_code }) => reason_code))).toEqual(
			new Set(['preauth_rate_limited', 'postauth_rate_limited'])
		);
		const boundedCounters = await database.query<{ last_reason_code: string }>(
			`SELECT last_reason_code FROM authentication_attempt_windows
			 WHERE credential_kind = 'api_key'
			   AND last_reason_code IN ('preauth_rate_limited', 'postauth_rate_limited')`
		);
		expect(new Set(boundedCounters.rows.map(({ last_reason_code }) => last_reason_code))).toEqual(
			new Set(['preauth_rate_limited', 'postauth_rate_limited'])
		);
	});

	it('durably records verifier-capacity denial before returning 429', async () => {
		let entered!: () => void;
		const verifierEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blockedVerifier = new Promise<boolean>((resolve) => {
			release = () => resolve(true);
		});
		const busyServices: AuthServices = {
			...services,
			apiKeys: new ApiKeyService(new PostgresApiKeyStore(database), 'test', {
				verifySecret: async () => {
					entered();
					return blockedVerifier;
				},
				maxConcurrentVerifications: 1,
				maxQueuedVerifications: 0
			})
		};
		const busyRouter = new Router<AuthServices>();
		busyRouter.get('/v1/verifier-audit-probe', async ({ request, services, requestId }) => {
			const principal = await authenticate(request, services);
			return principal
				? json({ organization_id: principal.organizationId })
				: problem(401, 'unauthorized', 'A valid credential is required.', requestId);
		});
		const first = busyRouter.handle(request('/v1/verifier-audit-probe', apiKey), busyServices);
		await verifierEntered;
		const limited = await busyRouter.handle(
			request('/v1/verifier-audit-probe', apiKey),
			busyServices
		);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('1');
		release();
		expect((await first).status).toBe(200);

		const evidence = await database.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM audit_events
			 WHERE action = 'authentication.api_key'
			   AND outcome = 'denied'
			   AND reason_code = 'verifier_capacity_limited'`
		);
		expect(Number(evidence.rows[0]?.count)).toBeGreaterThanOrEqual(1);
	});
});
