import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyService, PostgresApiKeyStore } from '../../src/auth/api-key.js';
import { DeviceAuthorizationService } from '../../src/auth/device.js';
import { AuditService } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { ProjectService } from '../../src/domain/projects.js';
import { Router } from '../../src/http/router.js';
import {
	registerDeviceAuthorizationRoutes,
	type DeviceAuthorizationRouteServices
} from '../../src/http/routes/device-authorization.js';
import {
	registerOrganizationRoutes,
	type OrganizationRouteServices
} from '../../src/http/routes/organizations.js';
import { listenRouter, type TestHttpServer } from '../helpers/http-server.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const pepper = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=';

type Services = DeviceAuthorizationRouteServices & OrganizationRouteServices;

databaseDescribe('real HTTP + PostgreSQL device authorization', () => {
	let database: Database;
	let http: TestHttpServer;
	let service: DeviceAuthorizationService;
	let currentTime: Date;
	const organizationA = randomUUID();
	const organizationB = randomUUID();
	const projectA = randomUUID();
	const projectB = randomUUID();
	const hostId = randomUUID();
	const regionId = `device-auth-${randomUUID()}`;
	const userId = randomUUID();
	const clerkUserId = `device-owner-${randomUUID()}`;
	const rateUserId = randomUUID();
	const rateClerkUserId = `device-rate-${randomUUID()}`;
	const suffix = randomUUID().replaceAll('-', '');
	const hostAddress = `fd00:6e65:6865:${suffix.slice(0, 4)}::10`;
	const machineId = `m_device_${suffix.slice(0, 16)}`;
	const machineLeaseId = randomUUID();
	const rateSession = `session-rate-limit-${suffix}`;

	const request = (
		path: string,
		body: unknown,
		session?: string,
		organization?: string,
		source = `device-test-${suffix}`
	) =>
		fetch(`${http.origin}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-nehemiah-remote-address': source,
				...(session ? { authorization: `Bearer ${session}` } : {}),
				...(organization ? { 'x-nehemiah-organization-id': organization } : {})
			},
			body: JSON.stringify(body)
		});

	const issue = async (scopes: string[] = ['machines:read', 'machines:write']) => {
		const response = await request('/v1/auth/device/code', {
			client_id: 'nehemiah-cli',
			scopes
		});
		expect(response.status).toBe(201);
		const issued = (await response.json()) as {
			device_code: string;
			user_code: string;
			expires_in: number;
		};
		return issued;
	};

	const approveAndExchange = async () => {
		const issued = await issue(['machines:read']);
		const approval = await request(
			'/v1/auth/device/authorize',
			{
				user_code: issued.user_code,
				decision: 'approve',
				project_id: projectA,
				scopes: ['machines:read']
			},
			'session-owner-a',
			organizationA
		);
		expect(approval.status).toBe(200);
		const exchange = await request('/v1/auth/device/token', { device_code: issued.device_code });
		expect(exchange.status).toBe(200);
		return (await exchange.json()) as {
			access_token: string;
			refresh_token: string;
		};
	};

	const insertDeviceGrant = async (
		accessToken: string
	): Promise<{ grantId: string; familyId: string }> => {
		const family = await database.query<{ family_id: string }>(
			`SELECT family_id::text FROM device_access_tokens
			 WHERE id = split_part($1, '_', 3)::uuid`,
			[accessToken]
		);
		const familyId = family.rows[0]!.family_id;
		const grantId = randomUUID();
		await database.query(
			`INSERT INTO machine_gateway_grants
			 (id, machine_id, organization_id, project_id, lease_id, capabilities, port,
			  expires_at, created_at, issuer_type, issuer_id)
			 VALUES ($1, $2, $3, $4, $5, ARRAY['files']::text[], NULL,
			         date_trunc('second', statement_timestamp()) + interval '5 minutes',
			         date_trunc('second', statement_timestamp()), 'device_family', $6)`,
			[grantId, machineId, organizationA, projectA, machineLeaseId, familyId]
		);
		return { grantId, familyId };
	};

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO regions (id, provider, display_name)
				 VALUES ($1, 'integration', 'Device authorization integration')`,
				[regionId]
			);
			await client.query(
				`INSERT INTO organizations (id, slug, name)
				 VALUES ($1, $2, 'Device auth A'), ($3, $4, 'Device auth B')`,
				[organizationA, `device-a-${suffix}`, organizationB, `device-b-${suffix}`]
			);
			await client.query(
				`INSERT INTO projects (id, organization_id, slug, name)
				 VALUES ($1, $2, $3, 'Device project A'), ($4, $5, $6, 'Device project B')`,
				[
					projectA,
					organizationA,
					`device-a-${suffix}`,
					projectB,
					organizationB,
					`device-b-${suffix}`
				]
			);
			await client.query('INSERT INTO users (id, clerk_user_id) VALUES ($1, $2), ($3, $4)', [
				userId,
				clerkUserId,
				rateUserId,
				rateClerkUserId
			]);
			await client.query(
				`INSERT INTO organization_members (organization_id, user_id, role)
				 VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
				[organizationA, userId, rateUserId]
			);
			await client.query(
				`INSERT INTO hosts
				 (id, provider_id, region_id, address, architecture, state, credential_hash,
				  control_credential_ciphertext, gateway_credential_ciphertext,
				  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
				  reported_available_vcpus, reported_available_memory_mb, reported_available_disk_mb,
				  runtime_cohort_id, runtime_contract_version, runtime_arch,
				  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
				  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
				 VALUES ($1, $2, $3, $4, 'x86_64', 'ready', 'test', 'test', 'test',
				         4, 4096, 20480, now(), 4, 4096, 20480,
				         repeat('a', 64), 4, 'amd64', repeat('b', 64), repeat('c', 64),
				         repeat('d', 64), repeat('e', 64), repeat('f', 64))`,
				[hostId, `device-auth-${hostId}`, regionId, hostAddress]
			);
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, host_id, host_machine_id, lease_id, idempotency_key,
				  idempotency_request_hash, state, region_id, architecture, template_name,
				  requested_ttl_seconds, vcpus, memory_mb, disk_mb, ready, started_at,
				  placed_at, ready_at, expires_at)
				 VALUES ($1, $2, $3, $4, 'device-auth-machine', $5, $6, $7, 'running', $8, 'x86_64',
				         'python', 900, 1, 512, 5120, true, now(), now(),
				         now(), now() + interval '15 minutes')`,
				[
					machineId,
					organizationA,
					projectA,
					hostId,
					machineLeaseId,
					`device-${suffix}`,
					'd'.repeat(64),
					regionId
				]
			);
		});
		currentTime = new Date('2026-08-09T12:00:00.000Z');
		service = new DeviceAuthorizationService(
			database,
			'https://boringcomputers.com/dashboard/device',
			pepper,
			() => currentTime
		);
		const organizations = new OrganizationService(database);
		const services: Services = {
			deviceAuthorizations: service,
			apiKeys: new ApiKeyService(new PostgresApiKeyStore(database), 'test'),
			audit: new AuditService(database),
			organizations,
			projects: new ProjectService(database),
			clerkSessionVerifier: async (token) => ({
				sub:
					token === 'session-owner-a'
						? clerkUserId
						: token === rateSession
							? rateClerkUserId
							: `rate-actor-${token}`
			})
		};
		const router = new Router<Services>();
		registerDeviceAuthorizationRoutes(router);
		registerOrganizationRoutes(router);
		http = await listenRouter(router, services);
	});

	beforeEach(() => {
		currentTime = new Date('2026-08-09T12:00:00.000Z');
	});

	afterAll(async () => {
		await http?.close();
		await database?.close();
	});

	it('approves once, binds access to one project, rotates refresh, and revokes on reuse', async () => {
		const issued = await issue();
		const stored = await database.query<{
			id: string;
			device_token_hash: Buffer;
			user_code_hash: Buffer;
		}>(
			`SELECT id, device_token_hash, user_code_hash FROM device_authorizations
			 ORDER BY created_at DESC LIMIT 1`
		);
		expect(stored.rows[0]?.device_token_hash.byteLength).toBe(32);
		expect(stored.rows[0]?.user_code_hash.byteLength).toBe(32);
		expect(
			stored.rows[0]?.user_code_hash.equals(
				createHash('sha256').update(issued.user_code.replace('-', '')).digest()
			)
		).toBe(false);
		const inspected = await request(
			'/v1/auth/device/inspect',
			{ user_code: issued.user_code },
			'session-owner-a'
		);
		expect(inspected.status).toBe(200);
		expect(await inspected.json()).toMatchObject({
			client_id: 'nehemiah-cli',
			scopes: ['machines:read', 'machines:write'],
			status: 'pending'
		});

		const malformedProject = await request(
			'/v1/auth/device/authorize',
			{
				user_code: issued.user_code,
				decision: 'approve',
				project_id: 'not-a-uuid',
				scopes: ['machines:read']
			},
			'session-owner-a',
			organizationA
		);
		expect(malformedProject.status).toBe(400);

		const crossTenant = await request(
			'/v1/auth/device/authorize',
			{
				user_code: issued.user_code,
				decision: 'approve',
				project_id: projectB,
				scopes: ['machines:read']
			},
			'session-owner-a',
			organizationA
		);
		expect(crossTenant.status).toBe(403);

		const crossOrganization = await request(
			'/v1/auth/device/authorize',
			{ user_code: issued.user_code, decision: 'deny' },
			'session-owner-a',
			organizationB
		);
		expect(crossOrganization.status).toBe(401);

		const approval = await request(
			'/v1/auth/device/authorize',
			{
				user_code: issued.user_code,
				decision: 'approve',
				project_id: projectA,
				scopes: ['machines:read']
			},
			'session-owner-a',
			organizationA
		);
		expect(approval.status).toBe(200);
		expect(
			(
				await request(
					'/v1/auth/device/authorize',
					{
						user_code: issued.user_code,
						decision: 'approve',
						project_id: projectA,
						scopes: ['machines:read']
					},
					'session-owner-a',
					organizationA
				)
			).status
		).toBe(409);

		const exchange = await request('/v1/auth/device/token', { device_code: issued.device_code });
		expect(exchange.status).toBe(200);
		const tokens = (await exchange.json()) as {
			access_token: string;
			refresh_token: string;
			project_id: string;
		};
		expect(tokens.project_id).toBe(projectA);
		const earlyRefresh = await request('/v1/auth/device/refresh', {
			refresh_token: tokens.refresh_token
		});
		expect(earlyRefresh.status).toBe(429);
		expect(earlyRefresh.headers.get('retry-after')).toBe('600');
		expect(await earlyRefresh.json()).toMatchObject({ title: 'slow_down', interval: 600 });
		const exchangedAgain = await request('/v1/auth/device/token', {
			device_code: issued.device_code
		});
		expect(exchangedAgain.status).toBe(400);
		expect(await exchangedAgain.json()).toMatchObject({ title: 'invalid_grant' });
		const storedCredentials = await database.query<{
			access_hash: Buffer;
			refresh_hash: Buffer;
		}>(
			`SELECT at.token_hash AS access_hash, rt.token_hash AS refresh_hash
			 FROM device_access_tokens at
			 JOIN device_refresh_tokens rt ON rt.family_id = at.family_id
			 WHERE at.id = split_part($1, '_', 3)::uuid AND rt.generation = 0`,
			[tokens.access_token]
		);
		expect(
			storedCredentials.rows[0]?.access_hash.equals(
				createHash('sha256').update(tokens.access_token).digest()
			)
		).toBe(true);
		expect(
			storedCredentials.rows[0]?.refresh_hash.equals(
				createHash('sha256').update(tokens.refresh_token).digest()
			)
		).toBe(true);
		const projectResponse = await fetch(`${http.origin}/v1/projects`, {
			headers: { authorization: `Bearer ${tokens.access_token}` }
		});
		expect(projectResponse.status).toBe(200);
		expect((await projectResponse.json()) as unknown).toMatchObject({
			projects: [{ id: projectA }]
		});
		expect(await service.authenticateAccess(tokens.access_token)).toMatchObject({
			organizationId: organizationA,
			projectId: projectA,
			scopes: new Set(['machines:read'])
		});
		const forgedAccess = `${tokens.access_token.slice(0, -1)}${tokens.access_token.endsWith('A') ? 'B' : 'A'}`;
		expect(
			(
				await fetch(`${http.origin}/v1/projects`, {
					headers: { authorization: `Bearer ${forgedAccess}` }
				})
			).status
		).toBe(401);
		currentTime = new Date(currentTime.getTime() + 901_000);
		expect(
			(
				await fetch(`${http.origin}/v1/projects`, {
					headers: { authorization: `Bearer ${tokens.access_token}` }
				})
			).status
		).toBe(401);

		const refresh = await request('/v1/auth/device/refresh', {
			refresh_token: tokens.refresh_token
		});
		expect(refresh.status).toBe(200);
		const rotated = (await refresh.json()) as {
			access_token: string;
			refresh_token: string;
		};
		expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
		const replayGrant = await insertDeviceGrant(rotated.access_token);
		const reuse = await request('/v1/auth/device/refresh', {
			refresh_token: tokens.refresh_token
		});
		expect(reuse.status).toBe(400);
		expect(await reuse.json()).toMatchObject({ title: 'refresh_reuse_detected' });
		const repeatedReuse = await request('/v1/auth/device/refresh', {
			refresh_token: tokens.refresh_token
		});
		expect(repeatedReuse.status).toBe(400);
		expect(await repeatedReuse.json()).toMatchObject({ title: 'refresh_reuse_detected' });
		expect(
			(
				await fetch(`${http.origin}/v1/projects`, {
					headers: { authorization: `Bearer ${rotated.access_token}` }
				})
			).status
		).toBe(401);
		const replayRevocation = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[replayGrant.grantId]
		);
		expect(replayRevocation.rows[0]?.revoked_at).toBeInstanceOf(Date);

		const events = await database.query<{ action: string; metadata: unknown }>(
			`SELECT action, metadata FROM audit_events
			 WHERE (organization_id = $1 OR resource_id = $2)
			   AND action LIKE 'device_authorization.%'`,
			[organizationA, stored.rows[0]!.id]
		);
		const serialized = JSON.stringify(events.rows);
		for (const secret of [
			issued.device_code,
			issued.user_code,
			tokens.access_token,
			tokens.refresh_token,
			rotated.access_token,
			rotated.refresh_token
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(events.rows.map(({ action }) => action)).toEqual(
			expect.arrayContaining([
				'device_authorization.requested',
				'device_authorization.approved',
				'device_authorization.exchanged',
				'device_authorization.refreshed',
				'device_authorization.refresh_reuse_detected'
			])
		);
		expect(
			events.rows.filter(({ action }) => action === 'device_authorization.refresh_reuse_detected')
		).toHaveLength(1);
	});

	it('revokes a family at the durable refresh-generation ceiling without adding rows', async () => {
		const tokens = await approveAndExchange();
		const refreshId = tokens.refresh_token.split('_')[2]!;
		await database.query(
			`UPDATE device_refresh_tokens
			 SET generation = 4095, created_at = $2
			 WHERE id = $1`,
			[refreshId, new Date(currentTime.getTime() - 601_000)]
		);
		const before = await database.query<{ refresh_count: number; access_count: number }>(
			`SELECT
			   (SELECT count(*)::integer FROM device_refresh_tokens WHERE family_id = family.id)
			     AS refresh_count,
			   (SELECT count(*)::integer FROM device_access_tokens WHERE family_id = family.id)
			     AS access_count
			 FROM device_refresh_families family
			 JOIN device_refresh_tokens token ON token.family_id = family.id
			 WHERE token.id = $1`,
			[refreshId]
		);
		const exhausted = await request('/v1/auth/device/refresh', {
			refresh_token: tokens.refresh_token
		});
		expect(exhausted.status).toBe(400);
		expect(await exhausted.json()).toMatchObject({ title: 'expired_token' });
		const after = await database.query<{
			refresh_count: number;
			access_count: number;
			revoked_at: Date | null;
			audit_count: number;
		}>(
			`SELECT
			   (SELECT count(*)::integer FROM device_refresh_tokens WHERE family_id = family.id)
			     AS refresh_count,
			   (SELECT count(*)::integer FROM device_access_tokens WHERE family_id = family.id)
			     AS access_count,
			   family.revoked_at,
			   (SELECT count(*)::integer FROM audit_events
			     WHERE resource_id = family.id::text
			       AND action = 'device_authorization.refresh_generation_exhausted') AS audit_count
			 FROM device_refresh_families family
			 JOIN device_refresh_tokens token ON token.family_id = family.id
			 WHERE token.id = $1`,
			[refreshId]
		);
		expect(after.rows[0]).toMatchObject({
			refresh_count: before.rows[0]!.refresh_count,
			access_count: before.rows[0]!.access_count,
			audit_count: 1
		});
		expect(after.rows[0]?.revoked_at).toBeInstanceOf(Date);
	});

	it('serializes concurrent refreshes and bounds the winning write before revoking reuse', async () => {
		const tokens = await approveAndExchange();
		currentTime = new Date(currentTime.getTime() + 601_000);
		const attempts = await Promise.all([
			request('/v1/auth/device/refresh', { refresh_token: tokens.refresh_token }),
			request('/v1/auth/device/refresh', { refresh_token: tokens.refresh_token })
		]);
		expect(attempts.map(({ status }) => status).sort()).toEqual([200, 400]);
		const family = await database.query<{
			refresh_count: number;
			access_count: number;
			revoked_at: Date | null;
			reuse_detected_at: Date | null;
		}>(
			`SELECT
			   (SELECT count(*)::integer FROM device_refresh_tokens WHERE family_id = family.id)
			     AS refresh_count,
			   (SELECT count(*)::integer FROM device_access_tokens WHERE family_id = family.id)
			     AS access_count,
			   family.revoked_at,
			   family.reuse_detected_at
			 FROM device_refresh_families family
			 JOIN device_refresh_tokens token ON token.family_id = family.id
			 WHERE token.id = $1`,
			[tokens.refresh_token.split('_')[2]!]
		);
		expect(family.rows[0]).toMatchObject({ refresh_count: 2, access_count: 2 });
		expect(family.rows[0]?.revoked_at).toBeInstanceOf(Date);
		expect(family.rows[0]?.reuse_detected_at).toBeInstanceOf(Date);
	});

	it('persists slow_down state, enforces expiry, and records one-time denial', async () => {
		const issued = await issue(['machines:read']);
		const initialViolation = await request('/v1/auth/device/token', {
			device_code: issued.device_code
		});
		expect(initialViolation.status).toBe(400);
		expect(await initialViolation.json()).toMatchObject({ title: 'slow_down', interval: 10 });
		currentTime = new Date(currentTime.getTime() + 10_000);
		const pending = await request('/v1/auth/device/token', { device_code: issued.device_code });
		expect(pending.status).toBe(400);
		expect(await pending.json()).toMatchObject({ title: 'authorization_pending', interval: 10 });
		const slow = await request('/v1/auth/device/token', { device_code: issued.device_code });
		expect(slow.status).toBe(400);
		expect(await slow.json()).toMatchObject({ title: 'slow_down', interval: 15 });
		const persisted = await database.query<{
			poll_interval_seconds: number;
			poll_violations: number;
		}>(
			`SELECT poll_interval_seconds, poll_violations FROM device_authorizations
			 WHERE device_token_hash = digest($1, 'sha256')`,
			[issued.device_code]
		);
		expect(persisted.rows[0]).toMatchObject({
			poll_interval_seconds: 15,
			poll_violations: 2
		});
		currentTime = new Date(currentTime.getTime() + 601_000);
		const expired = await request('/v1/auth/device/token', { device_code: issued.device_code });
		expect(expired.status).toBe(400);
		expect(await expired.json()).toMatchObject({ title: 'expired_token' });

		currentTime = new Date('2026-08-09T12:20:00.000Z');
		const deniedCode = await issue(['machines:read']);
		const denied = await request(
			'/v1/auth/device/authorize',
			{ user_code: deniedCode.user_code, decision: 'deny' },
			'session-owner-a',
			organizationA
		);
		expect(denied.status).toBe(200);
		const deniedExchange = await request('/v1/auth/device/token', {
			device_code: deniedCode.device_code
		});
		expect(deniedExchange.status).toBe(400);
		expect(await deniedExchange.json()).toMatchObject({ title: 'access_denied' });
		expect(
			(
				await request(
					'/v1/auth/device/authorize',
					{ user_code: deniedCode.user_code, decision: 'deny' },
					'session-owner-a',
					organizationA
				)
			).status
		).toBe(409);
		const denialAudit = await database.query(
			`SELECT 1 FROM audit_events
			 WHERE organization_id = $1 AND action = 'device_authorization.denied'
			   AND outcome = 'denied'`,
			[organizationA]
		);
		expect(denialAudit.rowCount).toBeGreaterThan(0);
	});

	it('commits invalid approval attempts before returning the rate limit', async () => {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const invalid = await request(
				'/v1/auth/device/inspect',
				{ user_code: 'not-a-code' },
				rateSession
			);
			expect(invalid.status).toBe(400);
		}
		const limited = await request(
			'/v1/auth/device/inspect',
			{ user_code: 'not-a-code' },
			rateSession
		);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		const persisted = await database.query<{ attempts: number }>(
			`SELECT attempts FROM device_authorization_rate_limits
			 WHERE kind = 'approve_actor' ORDER BY attempts DESC LIMIT 1`
		);
		expect(persisted.rows[0]?.attempts).toBeGreaterThanOrEqual(31);
	});

	it('commits unauthenticated issuance attempts before rejecting and rate limiting them', async () => {
		const source = `invalid-client-${suffix}`;
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const invalid = await request(
				'/v1/auth/device/code',
				{ client_id: 'not-allowed', scopes: ['machines:read'] },
				undefined,
				undefined,
				source
			);
			expect(invalid.status).toBe(400);
		}
		const limited = await request(
			'/v1/auth/device/code',
			{ client_id: 'not-allowed', scopes: ['machines:read'] },
			undefined,
			undefined,
			source
		);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		const persisted = await database.query<{ attempts: number }>(
			`SELECT attempts FROM device_authorization_rate_limits
			 WHERE kind = 'issue_source' ORDER BY attempts DESC LIMIT 1`
		);
		expect(persisted.rows[0]?.attempts).toBeGreaterThanOrEqual(11);
	});

	it('revokes a refresh family idempotently and audits the first revocation only', async () => {
		const issued = await issue(['machines:read']);
		expect(
			(
				await request(
					'/v1/auth/device/authorize',
					{
						user_code: issued.user_code,
						decision: 'approve',
						project_id: projectA,
						scopes: ['machines:read']
					},
					'session-owner-a',
					organizationA
				)
			).status
		).toBe(200);
		const exchange = await request('/v1/auth/device/token', { device_code: issued.device_code });
		const tokens = (await exchange.json()) as { access_token: string; refresh_token: string };
		const gatewayGrant = await insertDeviceGrant(tokens.access_token);
		expect(await service.authenticateAccess(tokens.access_token)).toMatchObject({
			deviceFamilyId: gatewayGrant.familyId
		});
		const first = await request('/v1/auth/device/revoke', {
			refresh_token: tokens.refresh_token
		});
		expect(first.status).toBe(204);
		expect(
			(
				await fetch(`${http.origin}/v1/projects`, {
					headers: { authorization: `Bearer ${tokens.access_token}` }
				})
			).status
		).toBe(401);
		const revokedGrant = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[gatewayGrant.grantId]
		);
		expect(revokedGrant.rows[0]?.revoked_at).toBeInstanceOf(Date);
		expect(
			(await request('/v1/auth/device/revoke', { refresh_token: tokens.refresh_token })).status
		).toBe(204);
		const audit = await database.query(
			`SELECT 1 FROM audit_events
			 WHERE organization_id = $1 AND action = 'device_authorization.revoked'`,
			[organizationA]
		);
		expect(audit.rowCount).toBe(1);
	});
});
