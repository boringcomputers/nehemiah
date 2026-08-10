import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	ApiKeyAllocationUnavailable,
	ApiKeyService,
	PostgresApiKeyStore,
	type ApiKeyMaterial,
	type ApiKeyScope
} from '../../src/auth/api-key.js';
import { DeviceAuthorizationService } from '../../src/auth/device.js';
import { AuditService } from '../../src/audit/audit.js';
import type {
	CreateOnHostRequest,
	HostClient,
	HostExecResult,
	HostMachine
} from '../../src/clients/nehemiahd.js';
import { Database, type Queryable } from '../../src/db/client.js';
import { IdentityLifecycleService } from '../../src/domain/identity-lifecycle.js';
import { HostService } from '../../src/domain/hosts.js';
import { MachineService, PostgresMachineRepository } from '../../src/domain/machines.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { Router } from '../../src/http/router.js';
import { registerApiKeyRoutes, type ApiKeyRouteServices } from '../../src/http/routes/api-keys.js';
import {
	registerIdentityLifecycleRoutes,
	type IdentityLifecycleRouteServices
} from '../../src/http/routes/identity-lifecycle.js';
import {
	registerMachineRoutes,
	type MachineRouteServices
} from '../../src/http/routes/machines.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { listenRouter } from '../helpers/http-server.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const pepper = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=';

const material = (publicId: string, character: string): ApiKeyMaterial => ({
	publicId,
	secret: character.repeat(43)
});

interface Tenant {
	readonly organizationId: string;
	readonly projectId: string;
	readonly userId: string;
	readonly clerkUserId: string;
}

interface DeviceCredential {
	readonly authorizationId: string;
	readonly familyId: string;
	readonly accessToken: string;
	readonly refreshToken: string;
}

class NoopHost implements HostClient {
	async create(_address: string, _request: CreateOnHostRequest): Promise<HostMachine> {
		throw new Error('host create is outside the identity lifecycle test');
	}
	async get(): Promise<HostMachine | undefined> {
		return undefined;
	}
	async destroy(): Promise<void> {}
	async extend(): Promise<HostMachine> {
		throw new Error('host extend is outside the identity lifecycle test');
	}
	async fork(): Promise<ReadonlyArray<HostMachine>> {
		throw new Error('host fork is outside the identity lifecycle test');
	}
	async exec(): Promise<HostExecResult> {
		throw new Error('host exec is outside the identity lifecycle test');
	}
}

databaseDescribe('authoritative identity and API-key lifecycle', () => {
	let database: Database;
	let identities: IdentityLifecycleService;
	let devices: DeviceAuthorizationService;
	let operator: Tenant;
	let runtimeHostId: string;

	const seedTenant = async (label: string): Promise<Tenant> => {
		const suffix = randomUUID().replaceAll('-', '');
		const tenant = {
			organizationId: randomUUID(),
			projectId: randomUUID(),
			userId: randomUUID(),
			clerkUserId: `${label}-${suffix}`
		};
		await database.transaction(async (client) => {
			await client.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`, [
				tenant.organizationId,
				`${label}-${suffix}`,
				`${label} organization`
			]);
			await client.query(
				`INSERT INTO projects (id, organization_id, slug, name)
				 VALUES ($1, $2, $3, $4)`,
				[tenant.projectId, tenant.organizationId, `${label}-${suffix}`, `${label} project`]
			);
			await client.query('INSERT INTO users (id, clerk_user_id) VALUES ($1, $2)', [
				tenant.userId,
				tenant.clerkUserId
			]);
			await client.query(
				`INSERT INTO organization_members (organization_id, user_id, role)
				 VALUES ($1, $2, 'owner')`,
				[tenant.organizationId, tenant.userId]
			);
		});
		return tenant;
	};

	const seedDevice = async (
		tenant: Tenant,
		scopes: ReadonlyArray<ApiKeyScope> = ['machines:read']
	): Promise<DeviceCredential> => {
		const authorizationId = randomUUID();
		const familyId = randomUUID();
		const accessId = randomUUID();
		const refreshId = randomUUID();
		const accessToken = `bc_access_${accessId}_${'A'.repeat(43)}`;
		const refreshToken = `bc_refresh_${refreshId}_${'R'.repeat(43)}`;
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO device_authorizations
				 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
				  approved_scopes, status, organization_id, project_id, approved_by,
				  expires_at, authorized_at, consumed_at)
				 VALUES ($1, $2, $3, 'identity-lifecycle-test', $4, $4, 'consumed',
				         $5, $6, $7, now() + interval '1 hour', now(), now())`,
				[
					authorizationId,
					createHash('sha256').update(randomUUID()).digest(),
					createHash('sha256').update(randomUUID()).digest(),
					scopes,
					tenant.organizationId,
					tenant.projectId,
					tenant.userId
				]
			);
			await client.query(
				`INSERT INTO device_refresh_families
				 (id, device_authorization_id, organization_id, project_id, scopes, expires_at)
				 VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
				[familyId, authorizationId, tenant.organizationId, tenant.projectId, scopes]
			);
			await client.query(
				`INSERT INTO device_refresh_tokens
				 (id, family_id, generation, token_hash, expires_at)
				 VALUES ($1, $2, 0, $3, now() + interval '1 day')`,
				[refreshId, familyId, createHash('sha256').update(refreshToken).digest()]
			);
			await client.query(
				`INSERT INTO device_access_tokens
				 (id, family_id, organization_id, project_id, scopes, token_hash, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')`,
				[
					accessId,
					familyId,
					tenant.organizationId,
					tenant.projectId,
					scopes,
					createHash('sha256').update(accessToken).digest()
				]
			);
		});
		return { authorizationId, familyId, accessToken, refreshToken };
	};

	const insertGrant = async (
		tenant: Tenant,
		issuer: { type: 'api_key' | 'clerk_user' | 'device_family'; id: string }
	): Promise<string> => {
		const machineId = `m_identity_${randomUUID().replaceAll('-', '')}`;
		const leaseId = randomUUID();
		const grantId = randomUUID();
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO machines
				 (id, organization_id, project_id, host_id, host_machine_id, lease_id, idempotency_key,
				  idempotency_request_hash, state, region_id, architecture, template_name,
				  requested_ttl_seconds, vcpus, memory_mb, disk_mb, expires_at,
				  runtime_cohort_id, source_sha256)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 'ca-tor-1', 'x86_64',
				         'python', 900, 1, 512, 5120, now() + interval '15 minutes', $9, $10)`,
				[
					machineId,
					tenant.organizationId,
					tenant.projectId,
					runtimeHostId,
					`host-${machineId}`,
					leaseId,
					`identity-${machineId}`,
					'a'.repeat(64),
					testRuntimeCohort.id,
					testRuntimeCohort.pythonRootfsSha256
				]
			);
			await client.query(
				`INSERT INTO machine_gateway_grants
				 (id, machine_id, organization_id, project_id, lease_id, capabilities, port,
				  expires_at, issuer_type, issuer_id)
				 VALUES ($1, $2, $3, $4, $5, ARRAY['files']::text[], NULL,
				         date_trunc('second', statement_timestamp()) + interval '5 minutes', $6, $7)`,
				[
					grantId,
					machineId,
					tenant.organizationId,
					tenant.projectId,
					leaseId,
					issuer.type,
					issuer.id
				]
			);
		});
		return grantId;
	};

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		runtimeHostId = randomUUID();
		await database.query(
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
				`identity-runtime-${runtimeHostId}`,
				`fd00:6e65:6865:${runtimeHostId.slice(0, 4)}::2`,
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
		identities = new IdentityLifecycleService(database);
		devices = new DeviceAuthorizationService(
			database,
			'https://boringcomputers.com/dashboard/device',
			pepper
		);
		operator = await seedTenant('identity-operator');
		await database.query('INSERT INTO fleet_operator_organizations (organization_id) VALUES ($1)', [
			operator.organizationId
		]);
	});

	afterAll(async () => {
		await database?.close();
	});

	it('denies a disabled user immediately, revokes every dependent credential, and audits system enable/disable', async () => {
		const tenant = await seedTenant('disabled-user');
		const first = await seedDevice(tenant);
		const second = await seedDevice(tenant);
		const clerkGrant = await insertGrant(tenant, {
			type: 'clerk_user',
			id: tenant.clerkUserId
		});
		const deviceGrant = await insertGrant(tenant, {
			type: 'device_family',
			id: first.familyId
		});
		expect(await devices.authenticateAccess(first.accessToken)).toBeDefined();

		const disabled = await identities.disableUser(tenant.userId, {
			actorType: 'system',
			actorId: 'clerk-lifecycle-sync',
			reason: 'upstream account disabled',
			requestId: 'disable-user-request'
		});
		expect(disabled).toMatchObject({ id: tenant.userId, changed: true });
		expect(await devices.authenticateAccess(first.accessToken)).toBeUndefined();
		await expect(devices.refresh(second.refreshToken)).rejects.toMatchObject({
			code: 'invalid_grant'
		});
		const contained = await database.query<{
			families: string;
			access_tokens: string;
			grants: string;
		}>(
			`SELECT
			 (SELECT count(*)::text FROM device_refresh_families
			   WHERE id = ANY($1::uuid[]) AND revoked_at IS NOT NULL) AS families,
			 (SELECT count(*)::text FROM device_access_tokens
			   WHERE family_id = ANY($1::uuid[]) AND revoked_at IS NOT NULL) AS access_tokens,
			 (SELECT count(*)::text FROM machine_gateway_grants
			   WHERE id = ANY($2::uuid[]) AND revoked_at IS NOT NULL) AS grants`,
			[
				[first.familyId, second.familyId],
				[clerkGrant, deviceGrant]
			]
		);
		expect(contained.rows[0]).toEqual({ families: '2', access_tokens: '2', grants: '2' });
		const organizations = new OrganizationService(database);
		expect(await organizations.userEnabled(tenant.clerkUserId)).toBe(false);
		expect(
			await organizations.membershipRole(tenant.clerkUserId, tenant.organizationId)
		).toBeUndefined();

		const enabled = await identities.enableUser(tenant.userId, {
			actorType: 'system',
			actorId: 'clerk-lifecycle-sync',
			reason: 'account restoration approved'
		});
		expect(enabled).toMatchObject({ changed: true, disabledAt: undefined });
		expect(await organizations.userEnabled(tenant.clerkUserId)).toBe(true);
		expect(await devices.authenticateAccess(first.accessToken)).toBeUndefined();
		const audit = await database.query<{ action: string; actor_type: string; outcome: string }>(
			`SELECT action, actor_type, outcome FROM audit_events
			 WHERE resource_id = $1 AND action LIKE 'identity.user.%' ORDER BY occurred_at`,
			[tenant.userId]
		);
		expect(audit.rows).toEqual([
			{ action: 'identity.user.disable', actor_type: 'system', outcome: 'succeeded' },
			{ action: 'identity.user.enable', actor_type: 'system', outcome: 'succeeded' }
		]);
	});

	it('revalidates both access and refresh against the approving current membership', async () => {
		const tenant = await seedTenant('membership-role');
		const access = await seedDevice(tenant, ['templates:write']);
		const refresh = await seedDevice(tenant, ['machines:read']);
		await database.query(
			`UPDATE organization_members SET role = 'billing'
			 WHERE organization_id = $1 AND user_id = $2`,
			[tenant.organizationId, tenant.userId]
		);
		expect(await devices.authenticateAccess(access.accessToken)).toBeUndefined();
		await expect(devices.refresh(refresh.refreshToken)).rejects.toMatchObject({
			code: 'invalid_grant'
		});
		const revoked = await database.query<{ count: string }>(
			`SELECT count(*)::text FROM device_refresh_families
			 WHERE id = ANY($1::uuid[]) AND revoked_at IS NOT NULL`,
			[[access.familyId, refresh.familyId]]
		);
		expect(revoked.rows[0]?.count).toBe('2');
		await database.query(
			`UPDATE organization_members SET role = 'owner'
			 WHERE organization_id = $1 AND user_id = $2`,
			[tenant.organizationId, tenant.userId]
		);
		expect(await devices.authenticateAccess(access.accessToken)).toBeUndefined();

		const removed = await seedDevice(tenant);
		await database.query(
			'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
			[tenant.organizationId, tenant.userId]
		);
		expect(await devices.authenticateAccess(removed.accessToken)).toBeUndefined();
		const removedFamily = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM device_refresh_families WHERE id = $1',
			[removed.familyId]
		);
		expect(removedFamily.rows[0]?.revoked_at).toBeInstanceOf(Date);
	});

	it('makes organization disable authoritative without resurrecting prior device sessions', async () => {
		const tenant = await seedTenant('disabled-organization');
		const keyService = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		const key = await keyService.create({
			organizationId: tenant.organizationId,
			name: 'organization lifecycle key',
			scopes: ['machines:read'],
			actorId: tenant.clerkUserId
		});
		const device = await seedDevice(tenant);
		expect(await keyService.authenticate(key.key)).toBeDefined();
		expect(await devices.authenticateAccess(device.accessToken)).toBeDefined();

		await identities.disableOrganization(tenant.organizationId, {
			actorType: 'user',
			actorId: operator.clerkUserId,
			actorOrganizationId: operator.organizationId,
			reason: 'incident containment'
		});
		expect(await keyService.authenticate(key.key)).toBeUndefined();
		expect(await devices.authenticateAccess(device.accessToken)).toBeUndefined();
		expect(
			await new OrganizationService(database).membershipRole(
				tenant.clerkUserId,
				tenant.organizationId
			)
		).toBeUndefined();

		await identities.enableOrganization(tenant.organizationId, {
			actorType: 'system',
			actorId: 'break-glass-recovery',
			reason: 'incident cleared'
		});
		expect(await keyService.authenticate(key.key)).toMatchObject({
			organizationId: tenant.organizationId
		});
		expect(await devices.authenticateAccess(device.accessToken)).toBeUndefined();
	});

	it('rechecks fleet-operator authority after route authentication before mutating identity state', async () => {
		const target = await seedTenant('operator-race-target');
		const realOrganizations = new OrganizationService(database);
		let crossedBarrier = false;
		const organizations = {
			membershipRole: async (clerkUserId: string, organizationId: string) => {
				const role = await realOrganizations.membershipRole(clerkUserId, organizationId);
				await database.query(
					`UPDATE organization_members SET role = 'member'
					 WHERE organization_id = $1 AND user_id = $2`,
					[operator.organizationId, operator.userId]
				);
				crossedBarrier = true;
				return role;
			}
		} as unknown as OrganizationService;
		const services: IdentityLifecycleRouteServices = {
			apiKeys: new ApiKeyService(new PostgresApiKeyStore(database), 'test'),
			audit: new AuditService(database),
			organizations,
			clerkSessionVerifier: async () => ({
				sub: operator.clerkUserId,
				org_id: operator.organizationId
			}),
			hosts: new HostService(database),
			identityLifecycle: identities
		};
		const router = new Router<IdentityLifecycleRouteServices>();
		registerIdentityLifecycleRoutes(router);
		const response = await router.handle(
			new Request(`https://api.example.test/v1/operator/users/${target.userId}/disable`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer operator-session',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ reason: 'race containment' })
			}),
			services
		);

		expect(crossedBarrier).toBe(true);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ title: 'fleet_operator_required' });
		const state = await database.query<{ disabled_at: Date | null }>(
			'SELECT disabled_at FROM users WHERE id = $1',
			[target.userId]
		);
		expect(state.rows[0]?.disabled_at).toBeNull();
		const denial = await database.query<{ outcome: string; reason_code: string }>(
			`SELECT outcome, reason_code FROM audit_events
			 WHERE resource_id = $1 AND action = 'identity.user.disable'
			 ORDER BY occurred_at DESC LIMIT 1`,
			[target.userId]
		);
		expect(denial.rows[0]).toEqual({
			outcome: 'denied',
			reason_code: 'operator_authorization_changed'
		});
		await database.query(
			`UPDATE organization_members SET role = 'owner'
			 WHERE organization_id = $1 AND user_id = $2`,
			[operator.organizationId, operator.userId]
		);
	});

	it('denies API-key enable and rotation when administrator authority changes after auth', async () => {
		const tenant = await seedTenant('api-key-actor-race');
		const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		const key = await apiKeys.create({
			organizationId: tenant.organizationId,
			name: 'actor race',
			scopes: ['machines:read'],
			actorId: tenant.clerkUserId
		});
		await apiKeys.disable(key.id, tenant.organizationId, tenant.clerkUserId);

		const racedRouter = (mutation: () => Promise<void>) => {
			const realOrganizations = new OrganizationService(database);
			const router = new Router<ApiKeyRouteServices>();
			registerApiKeyRoutes(router);
			return {
				router,
				services: {
					apiKeys,
					audit: new AuditService(database),
					organizations: {
						membershipRole: async (clerkUserId: string, organizationId: string) => {
							const role = await realOrganizations.membershipRole(clerkUserId, organizationId);
							await mutation();
							return role;
						}
					} as unknown as OrganizationService,
					clerkSessionVerifier: async () => ({
						sub: tenant.clerkUserId,
						org_id: tenant.organizationId
					})
				} satisfies ApiKeyRouteServices
			};
		};
		const request = (suffix: 'enable' | 'rotate') =>
			new Request(`https://api.example.test/v1/api-keys/${key.id}/${suffix}`, {
				method: 'POST',
				headers: { authorization: 'Bearer dashboard-session' }
			});
		const downgrade = async () => {
			await database.query(
				`UPDATE organization_members SET role = 'member'
				 WHERE organization_id = $1 AND user_id = $2`,
				[tenant.organizationId, tenant.userId]
			);
		};
		const enable = racedRouter(downgrade);
		expect((await enable.router.handle(request('enable'), enable.services)).status).toBe(403);
		let state = await database.query<{ disabled_at: Date | null; revoked_at: Date | null }>(
			'SELECT disabled_at, revoked_at FROM api_keys WHERE id = $1',
			[key.id]
		);
		expect(state.rows[0]?.disabled_at).toBeInstanceOf(Date);
		expect(state.rows[0]?.revoked_at).toBeNull();

		await database.query(
			`UPDATE organization_members SET role = 'owner'
			 WHERE organization_id = $1 AND user_id = $2`,
			[tenant.organizationId, tenant.userId]
		);
		await apiKeys.enable(key.id, tenant.organizationId, tenant.clerkUserId);
		const remove = async () => {
			await database.query(
				'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
				[tenant.organizationId, tenant.userId]
			);
		};
		const rotate = racedRouter(remove);
		expect((await rotate.router.handle(request('rotate'), rotate.services)).status).toBe(403);
		state = await database.query<{ disabled_at: Date | null; revoked_at: Date | null }>(
			'SELECT disabled_at, revoked_at FROM api_keys WHERE id = $1',
			[key.id]
		);
		expect(state.rows[0]).toEqual({ disabled_at: null, revoked_at: null });
		const keys = await database.query<{ count: string }>(
			'SELECT count(*)::text FROM api_keys WHERE organization_id = $1',
			[tenant.organizationId]
		);
		expect(keys.rows[0]?.count).toBe('1');
	});

	it('retries real prefix collisions and rotates atomically with disable and grant cascades', async () => {
		const tenant = await seedTenant('api-key-lifecycle');
		const store = new PostgresApiKeyStore(database);
		const publicIds = Array.from({ length: 3 }, () =>
			randomUUID().replaceAll('-', '').slice(0, 12)
		);
		const firstService = new ApiKeyService(store, 'test', {
			material: () => material(publicIds[0]!, 'A')
		});
		const first = await firstService.create({
			organizationId: tenant.organizationId,
			projectId: tenant.projectId,
			name: 'rotatable',
			scopes: ['machines:read'],
			actorId: tenant.clerkUserId
		});
		const collisionSequence = [material(publicIds[0]!, 'B'), material(publicIds[1]!, 'C')];
		const retrying = new ApiKeyService(store, 'test', {
			material: () => collisionSequence.shift()!
		});
		const second = await retrying.create({
			organizationId: tenant.organizationId,
			name: 'collision retry',
			scopes: ['machines:read'],
			actorId: tenant.clerkUserId
		});
		expect(second.prefix).toBe(`bc_test_${publicIds[1]}`);

		const rotationValues = [material(publicIds[1]!, 'D'), material(publicIds[2]!, 'E')];
		const rotating = new ApiKeyService(store, 'test', {
			material: () => rotationValues.shift()!
		});
		const apiKeyRouter = new Router<ApiKeyRouteServices>();
		registerApiKeyRoutes(apiKeyRouter);
		const routeServices: ApiKeyRouteServices = {
			apiKeys: rotating,
			audit: new AuditService(database),
			organizations: new OrganizationService(database),
			clerkSessionVerifier: async () => ({
				sub: tenant.clerkUserId,
				org_id: tenant.organizationId
			})
		};
		const lifecycleRequest = (suffix: string) =>
			apiKeyRouter.handle(
				new Request(`https://api.example.test/v1/api-keys/${first.id}/${suffix}`, {
					method: 'POST',
					headers: { authorization: 'Bearer dashboard-session' }
				}),
				routeServices
			);

		const disabledGrant = await insertGrant(tenant, { type: 'api_key', id: first.id });
		expect((await lifecycleRequest('disable')).status).toBe(204);
		expect(await firstService.authenticate(first.key)).toBeUndefined();
		expect((await lifecycleRequest('enable')).status).toBe(204);
		expect(await firstService.authenticate(first.key)).toBeDefined();
		const grantState = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[disabledGrant]
		);
		expect(grantState.rows[0]?.revoked_at).toBeInstanceOf(Date);

		const rotationResponse = await lifecycleRequest('rotate');
		expect(rotationResponse.status).toBe(201);
		expect(rotationResponse.headers.get('cache-control')).toBe('no-store');
		const replacement = (await rotationResponse.json()) as {
			id: string;
			key: string;
			prefix: string;
			rotated_from_id: string;
			secret_displayed_once: true;
		};
		expect(replacement).toMatchObject({
			prefix: `bc_test_${publicIds[2]}`,
			rotated_from_id: first.id,
			secret_displayed_once: true
		});
		expect(replacement?.prefix).toBe(`bc_test_${publicIds[2]}`);
		expect(await rotating.authenticate(first.key)).toBeUndefined();
		expect(await rotating.authenticate(replacement.key)).toMatchObject({
			apiKeyId: replacement.id,
			projectId: tenant.projectId
		});

		const exhausted = new ApiKeyService(store, 'test', {
			material: () => material(publicIds[2]!, 'F')
		});
		await expect(
			exhausted.rotate(second.id, tenant.organizationId, tenant.clerkUserId)
		).rejects.toBeInstanceOf(ApiKeyAllocationUnavailable);
		expect(await retrying.authenticate(second.key)).toMatchObject({ apiKeyId: second.id });

		const rotationAudit = await database.query<{
			action: string;
			operation_id: string;
			metadata: Record<string, unknown>;
		}>(
			`SELECT action, operation_id::text, metadata FROM audit_events
			 WHERE action IN ('api_key.rotated', 'api_key.rotation_created')
			   AND resource_id = ANY($1::text[]) ORDER BY action`,
			[[first.id, replacement.id]]
		);
		expect(rotationAudit.rows).toHaveLength(2);
		expect(new Set(rotationAudit.rows.map(({ operation_id }) => operation_id)).size).toBe(1);
		expect(JSON.stringify(rotationAudit.rows)).not.toContain(replacement.key);
	});

	it('fails session issuance when a key is disabled after authentication but before grant INSERT', async () => {
		const tenant = await seedTenant('grant-race');
		const apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		const key = await apiKeys.create({
			organizationId: tenant.organizationId,
			projectId: tenant.projectId,
			name: 'grant race',
			scopes: ['machines:write'],
			actorId: tenant.clerkUserId
		});
		const machineId = `m_grant_race_${randomUUID().replaceAll('-', '')}`;
		const leaseId = randomUUID();
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id, idempotency_key,
			  idempotency_request_hash, state, region_id, architecture, template_name,
			  requested_ttl_seconds, vcpus, memory_mb, disk_mb, ready, started_at,
			  ready_at, expires_at, runtime_cohort_id, source_sha256)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 'ca-tor-1', 'x86_64',
			         'python', 900, 1, 512, 5120, true, now(), now(),
			         now() + interval '15 minutes', $9, $10)`,
			[
				machineId,
				tenant.organizationId,
				tenant.projectId,
				runtimeHostId,
				`host-${machineId}`,
				leaseId,
				`grant-race-${machineId}`,
				'b'.repeat(64),
				testRuntimeCohort.id,
				testRuntimeCohort.pythonRootfsSha256
			]
		);

		let intercepted = false;
		const grantDatabase: Queryable = {
			query: async (text, values) => {
				if (!intercepted && text.includes('INSERT INTO machine_gateway_grants')) {
					intercepted = true;
					await database.query(
						'UPDATE api_keys SET disabled_at = statement_timestamp() WHERE id = $1',
						[key.id]
					);
				}
				return database.query(text, values);
			}
		};
		const services: MachineRouteServices = {
			database: grantDatabase,
			apiKeys,
			audit: new AuditService(database),
			organizations: new OrganizationService(database),
			machines: new MachineService(
				new PostgresMachineRepository(database),
				new Scheduler(database),
				new NoopHost()
			),
			gatewaySecret: 'identity-lifecycle-gateway-secret-long-enough',
			gatewayPublicUrl: 'https://gateway.identity.invalid'
		};
		const router = new Router<MachineRouteServices>();
		registerMachineRoutes(router);
		const http = await listenRouter(router, services);
		try {
			const response = await fetch(`${http.origin}/v1/machines/${machineId}/sessions`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${key.key}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ capabilities: ['files'], ttl_seconds: 120 })
			});
			expect(intercepted).toBe(true);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ title: 'machine_lease_changed' });
			const grants = await database.query<{ count: string }>(
				`SELECT count(*)::text FROM machine_gateway_grants
				 WHERE machine_id = $1 AND issuer_type = 'api_key' AND issuer_id = $2`,
				[machineId, key.id]
			);
			expect(grants.rows[0]?.count).toBe('0');
		} finally {
			await http.close();
		}
	});
});
