import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt, exportJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyService, PostgresApiKeyStore, type ApiKeyScope } from '../../src/auth/api-key.js';
import { verifyCapabilityToken } from '../../src/auth/capability.js';
import { clerkVerifier, type SessionVerifier } from '../../src/auth/clerk.js';
import { AuditService } from '../../src/audit/audit.js';
import type {
	CreateOnHostRequest,
	HostClient,
	HostExecResult,
	HostMachine
} from '../../src/clients/nehemiahd.js';
import { Database } from '../../src/db/client.js';
import { MachineService, PostgresMachineRepository } from '../../src/domain/machines.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { ProjectService } from '../../src/domain/projects.js';
import { TemplateService } from '../../src/domain/templates.js';
import { Router } from '../../src/http/router.js';
import { registerApiKeyRoutes, type ApiKeyRouteServices } from '../../src/http/routes/api-keys.js';
import { registerBillingRoutes, type BillingRouteServices } from '../../src/http/routes/billing.js';
import {
	registerMachineRoutes,
	type MachineRouteServices
} from '../../src/http/routes/machines.js';
import {
	registerOrganizationRoutes,
	type OrganizationRouteServices
} from '../../src/http/routes/organizations.js';
import {
	registerTemplateRoutes,
	type TemplateRouteServices
} from '../../src/http/routes/templates.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { listenRouter, type TestHttpServer } from '../helpers/http-server.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const gatewaySecret = 'http-integration-gateway-secret-that-is-long-enough';
const clerkAudience = 'nehemiah-dashboard';

type SecurityServices = MachineRouteServices &
	TemplateRouteServices &
	OrganizationRouteServices &
	ApiKeyRouteServices &
	BillingRouteServices;

interface TenantFixture {
	readonly organizations: { readonly a: string; readonly b: string };
	readonly projects: { readonly a1: string; readonly a2: string; readonly b1: string };
	readonly machines: { readonly a1: string; readonly a2: string; readonly b1: string };
	readonly leases: { readonly a1: string; readonly a2: string; readonly b1: string };
	readonly templates: { readonly a1: string; readonly a2: string; readonly b1: string };
	readonly users: {
		readonly ownerA: string;
		readonly adminAAndMemberB: string;
		readonly memberA: string;
		readonly billingA: string;
		readonly ownerB: string;
		readonly noMembership: string;
	};
}

interface KeyFixture {
	readonly organizationA: { readonly id: string; readonly key: string };
	readonly projectA1Read: { readonly id: string; readonly key: string };
	readonly projectA1Write: { readonly id: string; readonly key: string };
	readonly machinesWriteOnly: { readonly id: string; readonly key: string };
	readonly templatesReadOnly: { readonly id: string; readonly key: string };
	readonly expired: { readonly id: string; readonly key: string };
	readonly organizationB: { readonly id: string; readonly key: string };
}

interface ClerkSigner {
	readonly issuer: string;
	sign(input: {
		readonly subject?: string;
		readonly organizationId?: string;
		readonly issuer?: string;
		readonly audience?: string;
		readonly organizationRole?: string;
	}): Promise<string>;
	close(): Promise<void>;
}

class NoopHost implements HostClient {
	async create(_address: string, _request: CreateOnHostRequest): Promise<HostMachine> {
		throw new Error('host create is outside the HTTP security matrix');
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
	async extend(): Promise<HostMachine> {
		throw new Error('host extend is outside the HTTP security matrix');
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('host fork is outside the HTTP security matrix');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('host exec is outside the HTTP security matrix');
	}
}

const closeServer = async (server: Server): Promise<void> => {
	const closed = once(server, 'close');
	server.closeAllConnections();
	server.close();
	await closed;
};

const startClerkSigner = async (): Promise<ClerkSigner> => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
	const keyId = `test-${randomUUID()}`;
	const publicJwk = await exportJWK(publicKey);
	Object.assign(publicJwk, { alg: 'RS256', kid: keyId, use: 'sig' });
	const server = createServer((request, response) => {
		if (request.url !== '/.well-known/jwks.json') {
			response.statusCode = 404;
			response.end();
			return;
		}
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ keys: [publicJwk] }));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address() as AddressInfo;
	const issuer = `http://127.0.0.1:${address.port}`;

	return {
		issuer,
		async sign(input) {
			let token = new SignJWT({
				org_id: input.organizationId,
				org_role: input.organizationRole
			})
				.setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
				.setIssuer(input.issuer ?? issuer)
				.setAudience(input.audience ?? clerkAudience)
				.setIssuedAt()
				.setExpirationTime('5m');
			if (input.subject) token = token.setSubject(input.subject);
			return token.sign(privateKey);
		},
		close: () => closeServer(server)
	};
};

const machineId = (label: string): string => `m_${label}_${randomBytes(8).toString('hex')}`;
const templateHostName = (): string => `t-${randomBytes(15).toString('hex').slice(0, 29)}`;
const hash64 = (character: string): string => character.repeat(64);

const seedTenants = async (database: Database): Promise<TenantFixture> => {
	const fixture: TenantFixture = {
		organizations: { a: randomUUID(), b: randomUUID() },
		projects: { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() },
		machines: {
			a1: machineId('tenant_a_one'),
			a2: machineId('tenant_a_two'),
			b1: machineId('tenant_b_one')
		},
		leases: { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() },
		templates: { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() },
		users: {
			ownerA: `clerk_owner_a_${randomUUID()}`,
			adminAAndMemberB: `clerk_admin_a_member_b_${randomUUID()}`,
			memberA: `clerk_member_a_${randomUUID()}`,
			billingA: `clerk_billing_a_${randomUUID()}`,
			ownerB: `clerk_owner_b_${randomUUID()}`,
			noMembership: `clerk_no_membership_${randomUUID()}`
		}
	};
	const userIds = Object.fromEntries(
		Object.keys(fixture.users).map((key) => [key, randomUUID()])
	) as Record<keyof TenantFixture['users'], string>;
	const suffix = randomUUID().replaceAll('-', '');
	const runtimeHostId = randomUUID();

	await database.transaction(async (client) => {
		await client.query(
			`INSERT INTO organizations (id, slug, name)
			 VALUES ($1, $2, 'HTTP tenant A'), ($3, $4, 'HTTP tenant B')`,
			[fixture.organizations.a, `http-a-${suffix}`, fixture.organizations.b, `http-b-${suffix}`]
		);
		await client.query(
			`INSERT INTO projects (id, organization_id, slug, name)
			 VALUES ($1, $2, $3, 'Tenant A one'),
			        ($4, $2, $5, 'Tenant A two'),
			        ($6, $7, $8, 'Tenant B one')`,
			[
				fixture.projects.a1,
				fixture.organizations.a,
				`a-one-${suffix}`,
				fixture.projects.a2,
				`a-two-${suffix}`,
				fixture.projects.b1,
				fixture.organizations.b,
				`b-one-${suffix}`
			]
		);

		for (const [key, clerkUserId] of Object.entries(fixture.users) as Array<
			[keyof TenantFixture['users'], string]
		>) {
			await client.query('INSERT INTO users (id, clerk_user_id) VALUES ($1, $2)', [
				userIds[key],
				clerkUserId
			]);
		}
		await client.query(
			`INSERT INTO organization_members (organization_id, user_id, role)
			 VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'),
			        ($1, $5, 'billing'), ($6, $3, 'member'), ($6, $7, 'owner')`,
			[
				fixture.organizations.a,
				userIds.ownerA,
				userIds.adminAAndMemberB,
				userIds.memberA,
				userIds.billingA,
				fixture.organizations.b,
				userIds.ownerB
			]
		);
		await client.query(
			`INSERT INTO hosts
			 (id, provider_id, region_id, address, architecture, state, credential_hash,
			  control_credential_ciphertext, gateway_credential_ciphertext,
			  total_vcpus, total_memory_mb, total_disk_mb, last_heartbeat_at,
			  runtime_cohort_id, runtime_contract_version, runtime_arch,
			  runtime_kernel_sha256, runtime_firecracker_sha256, runtime_jailer_sha256,
			  runtime_python_rootfs_sha256, runtime_desktop_rootfs_sha256)
			 VALUES ($1, $2, 'ca-tor-1', $3, 'x86_64', 'stale', 'test', 'test', 'test',
			         8, 8192, 102400, now() - interval '1 day', $4, $5, $6, $7, $8, $9,
			         $10, $11)`,
			[
				runtimeHostId,
				`http-runtime-${runtimeHostId}`,
				`fd00:6e65:6865:${runtimeHostId.slice(0, 4)}::1`,
				testRuntimeCohort.id,
				testRuntimeCohort.contractVersion,
				testRuntimeCohort.arch,
				testRuntimeCohort.kernelSha256,
				testRuntimeCohort.firecrackerSha256,
				testRuntimeCohort.jailerSha256,
				testRuntimeCohort.pythonRootfsSha256,
				testRuntimeCohort.desktopRootfsSha256
			]
		);

		const machines = [
			{
				id: fixture.machines.a1,
				organization: fixture.organizations.a,
				project: fixture.projects.a1,
				lease: fixture.leases.a1,
				hash: hash64('a')
			},
			{
				id: fixture.machines.a2,
				organization: fixture.organizations.a,
				project: fixture.projects.a2,
				lease: fixture.leases.a2,
				hash: hash64('b')
			},
			{
				id: fixture.machines.b1,
				organization: fixture.organizations.b,
				project: fixture.projects.b1,
				lease: fixture.leases.b1,
				hash: hash64('c')
			}
		];
		for (const machine of machines) {
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, host_id, host_machine_id, lease_id, idempotency_key,
				  idempotency_request_hash, state, region_id, architecture, template_name,
				  requested_ttl_seconds, vcpus, memory_mb, disk_mb, ready, started_at,
				  ready_at, expires_at, runtime_cohort_id, source_sha256)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 'ca-tor-1', 'x86_64',
				         'python', 900, 1, 512, 5120, true, now(), now(),
				         now() + interval '15 minutes', $9, $10)`,
				[
					machine.id,
					machine.organization,
					machine.project,
					runtimeHostId,
					`host-${machine.id}`,
					machine.lease,
					`http-${machine.id}`,
					machine.hash,
					testRuntimeCohort.id,
					testRuntimeCohort.pythonRootfsSha256
				]
			);
		}

		const templates = [
			{
				id: fixture.templates.a1,
				organization: fixture.organizations.a,
				project: fixture.projects.a1,
				machine: fixture.machines.a1,
				checksum: hash64('1')
			},
			{
				id: fixture.templates.a2,
				organization: fixture.organizations.a,
				project: fixture.projects.a2,
				machine: fixture.machines.a2,
				checksum: hash64('2')
			},
			{
				id: fixture.templates.b1,
				organization: fixture.organizations.b,
				project: fixture.projects.b1,
				machine: fixture.machines.b1,
				checksum: hash64('3')
			}
		];
		for (const template of templates) {
			const objectKey = `organizations/${template.organization}/projects/${template.project}/templates/http/v1/${template.id}/snapshot.tar.zst`;
			const checksum = `sha256:${template.checksum}`;
			await client.query(
				`INSERT INTO templates
				 (id, organization_id, project_id, name, version, host_template_name,
				  source_machine_id, manifest, object_key, checksum, size_bytes)
				 VALUES ($1, $2, $3, 'http-template', 'v1', $4, $5, $6, $7, $8, 4096)`,
				[
					template.id,
					template.organization,
					template.project,
					templateHostName(),
					template.machine,
					{
						schema_version: 1,
						format: 'firecracker-snapshot-v1',
						architecture: 'x86_64',
						source: { machine_id: template.machine },
						artifact: { object_key: objectKey, checksum, size_bytes: 4096 }
					},
					objectKey,
					checksum
				]
			);
		}

		await client.query(
			`INSERT INTO billing_accounts (organization_id, plan)
			 VALUES ($1, 'tenant-a-plan'), ($2, 'tenant-b-plan')`,
			[fixture.organizations.a, fixture.organizations.b]
		);
		await client.query(
			`INSERT INTO usage_daily
			 (organization_id, project_id, usage_date, dimension, quantity)
			 VALUES ($1, $2, CURRENT_DATE, 'vcpu_seconds', 11),
			        ($3, $4, CURRENT_DATE, 'vcpu_seconds', 99)`,
			[fixture.organizations.a, fixture.projects.a1, fixture.organizations.b, fixture.projects.b1]
		);
	});
	return fixture;
};

const createKeys = async (
	database: Database,
	apiKeys: ApiKeyService,
	fixture: TenantFixture
): Promise<KeyFixture> => {
	const create = (
		organizationId: string,
		name: string,
		scopes: ReadonlyArray<ApiKeyScope>,
		projectId?: string,
		expiresAt?: Date
	) => apiKeys.create({ organizationId, projectId, name, scopes, expiresAt });
	const organizationA = await create(fixture.organizations.a, 'Organization A integration', [
		'machines:read',
		'machines:write',
		'templates:read',
		'templates:write',
		'billing:read'
	]);
	const projectA1Read = await create(
		fixture.organizations.a,
		'Project A1 read integration',
		['machines:read', 'templates:read'],
		fixture.projects.a1
	);
	const projectA1Write = await create(
		fixture.organizations.a,
		'Project A1 write integration',
		['machines:write', 'templates:write'],
		fixture.projects.a1
	);
	const machinesWriteOnly = await create(
		fixture.organizations.a,
		'Machine write only integration',
		['machines:write']
	);
	const templatesReadOnly = await create(
		fixture.organizations.a,
		'Template read only integration',
		['templates:read']
	);
	const expired = await create(
		fixture.organizations.a,
		'Expired integration',
		['machines:read'],
		undefined,
		new Date(Date.now() + 60_000)
	);
	await database.query(
		`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`,
		[expired.id]
	);
	const organizationB = await create(fixture.organizations.b, 'Organization B integration', [
		'machines:read',
		'machines:write',
		'templates:read',
		'templates:write'
	]);
	return {
		organizationA,
		projectA1Read,
		projectA1Write,
		machinesWriteOnly,
		templatesReadOnly,
		expired,
		organizationB
	};
};

const authorization = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });
const jsonBody = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

const jsonResponse = async <Body>(response: Response): Promise<Body> =>
	(await response.json()) as Body;

databaseDescribe('real HTTP + PostgreSQL tenant and authentication isolation', () => {
	let database: Database;
	let fixture: TenantFixture;
	let keys: KeyFixture;
	let clerk: ClerkSigner;
	let verifyClerk: SessionVerifier;
	let http: TestHttpServer;

	const request = (path: string, init?: RequestInit): Promise<Response> =>
		fetch(`${http.origin}${path}`, init);
	const requestWithBearer = (
		path: string,
		token: string,
		init: RequestInit = {}
	): Promise<Response> =>
		request(path, {
			...init,
			headers: { ...Object.fromEntries(new Headers(init.headers)), ...authorization(token) }
		});

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		await database.query('SELECT 1');
		fixture = await seedTenants(database);
		const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		keys = await createKeys(database, apiKeys, fixture);
		clerk = await startClerkSigner();
		verifyClerk = clerkVerifier(clerk.issuer, clerkAudience);
		const services: SecurityServices = {
			database,
			apiKeys,
			audit: new AuditService(database),
			organizations: new OrganizationService(database),
			projects: new ProjectService(database),
			templates: new TemplateService(database),
			machines: new MachineService(
				new PostgresMachineRepository(database),
				new Scheduler(database),
				new NoopHost()
			),
			gatewaySecret,
			gatewayPublicUrl: 'https://gateway.integration.invalid',
			previewBaseDomain: 'preview.integration.invalid',
			clerkSessionVerifier: verifyClerk
		};
		const router = new Router<SecurityServices>();
		registerMachineRoutes(router);
		registerTemplateRoutes(router);
		registerOrganizationRoutes(router);
		registerApiKeyRoutes(router);
		registerBillingRoutes(router);
		http = await listenRouter(router, services);
	});

	afterAll(async () => {
		await http?.close();
		await clerk?.close();
		await database?.close();
	});

	it('enforces API-key expiry and least-privilege scopes at the HTTP boundary', async () => {
		const expired = await requestWithBearer('/v1/machines', keys.expired.key);
		expect(expired.status).toBe(401);

		const writeOnlyRead = await requestWithBearer('/v1/machines', keys.machinesWriteOnly.key);
		expect(writeOnlyRead.status).toBe(403);
		expect(await jsonResponse<{ title: string }>(writeOnlyRead)).toMatchObject({
			title: 'insufficient_scope'
		});

		const templatesOnlyMachines = await requestWithBearer(
			'/v1/machines',
			keys.templatesReadOnly.key
		);
		expect(templatesOnlyMachines.status).toBe(403);
		const templatesOnlyTemplates = await requestWithBearer(
			'/v1/templates',
			keys.templatesReadOnly.key
		);
		expect(templatesOnlyTemplates.status).toBe(200);
	});

	it('rejects managed public egress before machine persistence', async () => {
		const key = `managed-egress-${randomUUID()}`;
		const response = await requestWithBearer('/v1/machines', keys.projectA1Write.key, {
			...jsonBody({
				project_id: fixture.projects.a1,
				template: 'python',
				network_policy: {
					mode: 'allowlist',
					hostnames: [],
					cidrs: ['1.1.1.0/24']
				}
			}),
			headers: { 'content-type': 'application/json', 'idempotency-key': key }
		});
		expect(response.status).toBe(501);
		expect(await jsonResponse<{ title: string }>(response)).toMatchObject({
			title: 'not_supported'
		});
		const persisted = await database.query<{ count: string }>(
			`SELECT count(*)::text FROM machines
			 WHERE organization_id = $1 AND project_id = $2 AND idempotency_key = $3`,
			[fixture.organizations.a, fixture.projects.a1, key]
		);
		expect(persisted.rows[0]?.count).toBe('0');
	});

	it('does not disclose cross-organization or cross-project machines', async () => {
		const own = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}`,
			keys.projectA1Read.key
		);
		expect(own.status).toBe(200);

		for (const hiddenMachine of [fixture.machines.a2, fixture.machines.b1]) {
			const hidden = await requestWithBearer(
				`/v1/machines/${hiddenMachine}`,
				keys.projectA1Read.key
			);
			expect(hidden.status).toBe(404);
		}

		const crossOrganizationFilter = await requestWithBearer(
			`/v1/machines?project_id=${fixture.projects.b1}`,
			keys.organizationA.key
		);
		expect(crossOrganizationFilter.status).toBe(200);
		expect(
			(await jsonResponse<{ machines: Array<{ id: string }> }>(crossOrganizationFilter)).machines
		).toEqual([]);

		const attemptedScopedOverride = await requestWithBearer(
			`/v1/machines?project_id=${fixture.projects.a2}`,
			keys.projectA1Read.key
		);
		expect(attemptedScopedOverride.status).toBe(200);
		expect(
			(
				await jsonResponse<{ machines: Array<{ id: string }> }>(attemptedScopedOverride)
			).machines.map((machine) => machine.id)
		).toEqual([fixture.machines.a1]);
	});

	it('isolates template lookup and deletion across tenant and project boundaries', async () => {
		const crossOrganizationList = await requestWithBearer(
			`/v1/templates?project_id=${fixture.projects.b1}`,
			keys.organizationA.key
		);
		expect(crossOrganizationList.status).toBe(200);
		expect((await jsonResponse<{ templates: unknown[] }>(crossOrganizationList)).templates).toEqual(
			[]
		);

		const crossProjectList = await requestWithBearer(
			`/v1/templates?project_id=${fixture.projects.a2}`,
			keys.projectA1Read.key
		);
		expect(crossProjectList.status).toBe(403);

		const crossProjectDelete = await requestWithBearer(
			`/v1/templates/${fixture.templates.a2}?project_id=${fixture.projects.a2}`,
			keys.projectA1Write.key,
			{ method: 'DELETE' }
		);
		expect(crossProjectDelete.status).toBe(403);

		const crossOrganizationDelete = await requestWithBearer(
			`/v1/templates/${fixture.templates.b1}`,
			keys.organizationA.key,
			{ method: 'DELETE' }
		);
		expect(crossOrganizationDelete.status).toBe(404);
		const untouched = await database.query<{ deleted_at: Date | null }>(
			'SELECT deleted_at FROM templates WHERE id = $1',
			[fixture.templates.b1]
		);
		expect(untouched.rows[0]?.deleted_at).toBeNull();
	});

	it('binds issued session capabilities to the authorized tenant, project, machine and lease', async () => {
		const preview = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			keys.projectA1Write.key,
			jsonBody({ capabilities: ['preview'], port: 3_000, ttl_seconds: 120 })
		);
		expect(preview.status).toBe(200);
		expect(preview.headers.get('cache-control')).toBe('no-store');
		const session = await jsonResponse<{ id: string; token: string; preview_url: string }>(preview);
		const sessionPayload = decodeJwt(session.token);
		expect(sessionPayload.jti).toMatch(/^[0-9a-f-]{36}$/i);
		expect(session.id).toBe(sessionPayload.jti);
		await expect(verifyCapabilityToken(session.token, `${gatewaySecret}-wrong`)).rejects.toThrow();
		expect(await verifyCapabilityToken(session.token, gatewaySecret)).toEqual({
			machineId: fixture.machines.a1,
			organizationId: fixture.organizations.a,
			projectId: fixture.projects.a1,
			leaseId: fixture.leases.a1,
			capabilities: ['preview'],
			port: 3_000
		});
		expect(session.preview_url).toContain('/preview/');
		expect(session.preview_url).toContain('#token=');
		const durableGrant = await database.query<{
			machine_id: string;
			organization_id: string;
			project_id: string;
			lease_id: string;
			capabilities: string[];
			port: number | null;
			expires_at: Date;
			issuer_type: string;
			issuer_id: string;
			revoked_at: Date | null;
		}>(
			`SELECT machine_id, organization_id::text, project_id::text, lease_id::text,
			        capabilities, port, expires_at, issuer_type, issuer_id, revoked_at
			 FROM machine_gateway_grants WHERE id = $1`,
			[sessionPayload.jti]
		);
		expect(durableGrant.rows[0]).toEqual({
			machine_id: fixture.machines.a1,
			organization_id: fixture.organizations.a,
			project_id: fixture.projects.a1,
			lease_id: fixture.leases.a1,
			capabilities: ['preview'],
			port: 3_000,
			expires_at: new Date((sessionPayload.exp ?? 0) * 1_000),
			issuer_type: 'api_key',
			issuer_id: keys.projectA1Write.id,
			revoked_at: null
		});

		for (const hiddenMachine of [fixture.machines.a2, fixture.machines.b1]) {
			const hidden = await requestWithBearer(
				`/v1/machines/${hiddenMachine}/sessions`,
				keys.projectA1Write.key,
				jsonBody({ capabilities: ['tty'] })
			);
			expect(hidden.status).toBe(404);
		}

		const readOnly = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			keys.projectA1Read.key,
			jsonBody({ capabilities: ['tty'] })
		);
		expect(readOnly.status).toBe(404);

		const replacementLease = randomUUID();
		await database.query('UPDATE machines SET lease_id = $2 WHERE id = $1', [
			fixture.machines.a1,
			replacementLease
		]);
		const response = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			keys.projectA1Write.key,
			jsonBody({ capabilities: ['tty'] })
		);
		expect(response.status).toBe(200);
		const body = await jsonResponse<{ token: string }>(response);
		const ttyClaims = await verifyCapabilityToken(body.token, gatewaySecret);
		expect(ttyClaims.leaseId).toBe(replacementLease);
		expect(replacementLease).not.toBe(fixture.leases.a1);
		const ttyGrant = await database.query<{ capabilities: string[]; port: number | null }>(
			'SELECT capabilities, port FROM machine_gateway_grants WHERE id = $1',
			[decodeJwt(body.token).jti]
		);
		expect(ttyGrant.rows[0]).toEqual({ capabilities: ['tty'], port: null });
	});

	it('rejects managed host-local agent sessions without durable side effects', async () => {
		const before = await database.query<{ grants: string; audits: string }>(
			`SELECT
			   (SELECT count(*)::text FROM machine_gateway_grants
			     WHERE machine_id = $1 AND capabilities @> ARRAY['agent']::text[]) AS grants,
			   (SELECT count(*)::text FROM audit_events
			     WHERE resource_id = $1 AND action = 'machine.session.issue') AS audits`,
			[fixture.machines.a1]
		);
		const response = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			keys.projectA1Write.key,
			jsonBody({ capabilities: ['agent'], ttl_seconds: 120 })
		);
		expect(response.status).toBe(501);
		expect(await jsonResponse<{ title: string }>(response)).toMatchObject({
			title: 'not_supported'
		});
		const after = await database.query<{ grants: string; audits: string }>(
			`SELECT
			   (SELECT count(*)::text FROM machine_gateway_grants
			     WHERE machine_id = $1 AND capabilities @> ARRAY['agent']::text[]) AS grants,
			   (SELECT count(*)::text FROM audit_events
			     WHERE resource_id = $1 AND action = 'machine.session.issue') AS audits`,
			[fixture.machines.a1]
		);
		expect(after.rows[0]).toEqual(before.rows[0]);
	});

	it('revokes a session idempotently without exposing it across tenants', async () => {
		const issued = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			keys.projectA1Write.key,
			jsonBody({ capabilities: ['files'], ttl_seconds: 120 })
		);
		expect(issued.status).toBe(200);
		const session = await jsonResponse<{ id: string; token: string }>(issued);
		expect(session.id).toBe(decodeJwt(session.token).jti);

		const crossTenant = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions/${session.id}`,
			keys.organizationB.key,
			{ method: 'DELETE' }
		);
		expect(crossTenant.status).toBe(404);
		const before = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[session.id]
		);
		expect(before.rows[0]?.revoked_at).toBeNull();

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const revoked = await requestWithBearer(
				`/v1/machines/${fixture.machines.a1}/sessions/${session.id}`,
				keys.projectA1Write.key,
				{ method: 'DELETE' }
			);
			expect(revoked.status).toBe(204);
			expect(revoked.headers.get('cache-control')).toBe('no-store');
		}
		const after = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[session.id]
		);
		expect(after.rows[0]?.revoked_at).toBeInstanceOf(Date);
		expect(JSON.stringify(after.rows[0])).not.toContain(session.token);
	});

	it('binds dashboard-issued sessions to the current Clerk user membership', async () => {
		const clerkSession = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a,
			organizationRole: 'org:owner'
		});
		const issued = await requestWithBearer(
			`/v1/machines/${fixture.machines.a1}/sessions`,
			clerkSession,
			jsonBody({ capabilities: ['tty'], ttl_seconds: 60 })
		);
		expect(issued.status).toBe(200);
		const session = await jsonResponse<{ id: string }>(issued);
		const grant = await database.query<{ issuer_type: string; issuer_id: string }>(
			'SELECT issuer_type, issuer_id FROM machine_gateway_grants WHERE id = $1',
			[session.id]
		);
		expect(grant.rows[0]).toEqual({
			issuer_type: 'clerk_user',
			issuer_id: fixture.users.ownerA
		});
	});

	it('validates Clerk issuer, audience and subject through a real JWKS endpoint', async () => {
		const valid = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a
		});
		const validResponse = await requestWithBearer('/v1/organizations', valid);
		expect(validResponse.status).toBe(200);

		const invalidTokens = [
			await clerk.sign({
				subject: fixture.users.ownerA,
				organizationId: fixture.organizations.a,
				issuer: 'https://wrong-issuer.integration.invalid'
			}),
			await clerk.sign({
				subject: fixture.users.ownerA,
				organizationId: fixture.organizations.a,
				audience: 'wrong-audience'
			}),
			await clerk.sign({ organizationId: fixture.organizations.a })
		];
		for (const token of invalidTokens) {
			const response = await requestWithBearer('/v1/organizations', token);
			expect(response.status).toBe(403);
		}
	});

	it('uses database membership roles instead of untrusted Clerk role claims', async () => {
		const ownerClaimingBilling = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a,
			organizationRole: 'billing'
		});
		const created = await requestWithBearer(
			'/v1/projects',
			ownerClaimingBilling,
			jsonBody({ name: 'Database owner role', slug: `db-owner-${randomBytes(5).toString('hex')}` })
		);
		expect(created.status).toBe(201);
		expect(
			await jsonResponse<{ max_disk_mb: unknown; max_storage_mb: unknown }>(created)
		).toMatchObject({ max_disk_mb: expect.any(Number), max_storage_mb: expect.any(Number) });

		const billingClaimingOwner = await clerk.sign({
			subject: fixture.users.billingA,
			organizationId: fixture.organizations.a,
			organizationRole: 'owner'
		});
		const machines = await requestWithBearer('/v1/machines', billingClaimingOwner);
		expect(machines.status).toBe(403);
		const usage = await requestWithBearer('/v1/billing/usage', billingClaimingOwner);
		expect(usage.status).toBe(200);
		const usageBody = await jsonResponse<{
			account: { plan: string };
			usage: Array<{ project_id: string; quantity: string }>;
		}>(usage);
		expect(usageBody.account.plan).toBe('tenant-a-plan');
		expect(usageBody.usage).toEqual([
			expect.objectContaining({ project_id: fixture.projects.a1, quantity: '11.000000000' })
		]);

		const memberClaimingAdmin = await clerk.sign({
			subject: fixture.users.memberA,
			organizationId: fixture.organizations.a,
			organizationRole: 'admin'
		});
		const memberProjectCreate = await requestWithBearer(
			'/v1/projects',
			memberClaimingAdmin,
			jsonBody({ name: 'Denied', slug: `denied-${randomBytes(5).toString('hex')}` })
		);
		expect(memberProjectCreate.status).toBe(403);
		const memberKeyCreate = await requestWithBearer(
			'/v1/api-keys',
			memberClaimingAdmin,
			jsonBody({ name: 'Denied', scopes: ['machines:read'] })
		);
		expect(memberKeyCreate.status).toBe(403);
	});

	it('permits organization switching only through a real membership and applies that role', async () => {
		const ownerA = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a
		});
		const noMembership = await requestWithBearer('/v1/projects', ownerA, {
			headers: { 'x-nehemiah-organization-id': fixture.organizations.b }
		});
		expect(noMembership.status).toBe(401);
		const validButUnassigned = await clerk.sign({
			subject: fixture.users.noMembership,
			organizationId: fixture.organizations.a
		});
		expect((await requestWithBearer('/v1/projects', validButUnassigned)).status).toBe(401);

		const sharedUser = await clerk.sign({
			subject: fixture.users.adminAAndMemberB,
			organizationId: fixture.organizations.a,
			organizationRole: 'admin'
		});
		const adminCreate = await requestWithBearer(
			'/v1/projects',
			sharedUser,
			jsonBody({ name: 'Admin in A', slug: `admin-a-${randomBytes(5).toString('hex')}` })
		);
		expect(adminCreate.status).toBe(201);
		const switched = await requestWithBearer('/v1/projects', sharedUser, {
			headers: { 'x-nehemiah-organization-id': fixture.organizations.b }
		});
		expect(switched.status).toBe(200);
		expect(
			(await jsonResponse<{ projects: Array<{ id: string }> }>(switched)).projects.map(
				(project) => project.id
			)
		).toEqual([fixture.projects.b1]);
		const switchedCreate = await requestWithBearer('/v1/projects', sharedUser, {
			...jsonBody({ name: 'Denied in B', slug: `denied-b-${randomBytes(5).toString('hex')}` }),
			headers: {
				'content-type': 'application/json',
				'x-nehemiah-organization-id': fixture.organizations.b
			}
		});
		expect(switchedCreate.status).toBe(403);
	});

	it('isolates project listings for organization-wide and project-scoped API keys', async () => {
		const organizationProjects = await requestWithBearer('/v1/projects', keys.organizationA.key);
		expect(organizationProjects.status).toBe(200);
		const organizationProjectBody = await jsonResponse<{
			projects: Array<{ id: string; max_disk_mb: unknown; max_storage_mb: unknown }>;
		}>(organizationProjects);
		expect(
			organizationProjectBody.projects.every(
				(project) =>
					typeof project.max_disk_mb === 'number' && typeof project.max_storage_mb === 'number'
			)
		).toBe(true);
		const organizationIds = organizationProjectBody.projects.map((project) => project.id);
		expect(organizationIds).toEqual(
			expect.arrayContaining([fixture.projects.a1, fixture.projects.a2])
		);
		expect(organizationIds).not.toContain(fixture.projects.b1);

		const scopedProjects = await requestWithBearer('/v1/projects', keys.projectA1Read.key);
		expect(scopedProjects.status).toBe(200);
		expect(
			(await jsonResponse<{ projects: Array<{ id: string }> }>(scopedProjects)).projects.map(
				(project) => project.id
			)
		).toEqual([fixture.projects.a1]);

		const organizations = await requestWithBearer('/v1/organizations', keys.organizationA.key);
		expect(organizations.status).toBe(403);
	});

	it('prevents an organization administrator from reading or revoking another tenant API key', async () => {
		const ownerA = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a
		});
		const listed = await requestWithBearer('/v1/api-keys', ownerA);
		expect(listed.status).toBe(200);
		const listedIds = (
			await jsonResponse<{ api_keys: Array<{ id: string }> }>(listed)
		).api_keys.map((key) => key.id);
		expect(listedIds).toContain(keys.organizationA.id);
		expect(listedIds).not.toContain(keys.organizationB.id);

		const crossProjectList = await requestWithBearer(
			`/v1/api-keys?project_id=${fixture.projects.b1}`,
			ownerA
		);
		expect(crossProjectList.status).toBe(200);
		expect((await jsonResponse<{ api_keys: unknown[] }>(crossProjectList)).api_keys).toEqual([]);

		const revoke = await requestWithBearer(`/v1/api-keys/${keys.organizationB.id}`, ownerA, {
			method: 'DELETE'
		});
		expect(revoke.status).toBe(404);
		expect(
			await new ApiKeyService(new PostgresApiKeyStore(database), 'test').authenticate(
				keys.organizationB.key
			)
		).toMatchObject({ organizationId: fixture.organizations.b });
	});

	it('rejects cross-tenant project binding when an administrator creates an API key', async () => {
		const ownerA = await clerk.sign({
			subject: fixture.users.ownerA,
			organizationId: fixture.organizations.a
		});
		const response = await requestWithBearer(
			'/v1/api-keys',
			ownerA,
			jsonBody({
				name: 'Cross tenant must fail',
				project_id: fixture.projects.b1,
				scopes: ['machines:read']
			})
		);
		expect([400, 404]).toContain(response.status);
		const crossBound = await database.query<{ count: string }>(
			`SELECT count(*) FROM api_keys
			 WHERE organization_id = $1 AND project_id = $2`,
			[fixture.organizations.a, fixture.projects.b1]
		);
		expect(Number(crossBound.rows[0]?.count)).toBe(0);
	});
});
