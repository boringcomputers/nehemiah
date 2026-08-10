import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyService, PostgresApiKeyStore } from '../../src/auth/api-key.js';
import type { GatewayCapability } from '../../src/auth/capability.js';
import type { AuditService } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import { HostCredentialCipher } from '../../src/domain/host-credentials.js';
import { HostService } from '../../src/domain/hosts.js';
import type { OrganizationService } from '../../src/domain/organizations.js';
import { StreamAdmissionService } from '../../src/domain/stream-admission.js';
import { Router } from '../../src/http/router.js';
import {
	registerInternalHostRoutes,
	type InternalRouteServices
} from '../../src/http/routes/internal-hosts.js';
import { reapExpiredGatewayGrants } from '../../src/jobs/reap-expired-gateway-grants.js';
import { testRuntimeCohort } from '../runtime-cohort-fixture.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const encodedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const gatewayServiceToken = 'gateway-service-token';
const hostGatewayToken = 'host-gateway-token-'.padEnd(48, 'g');

const machineId = (): string => `m_gateway_${randomBytes(8).toString('hex')}`;
const secondTimestamp = (offsetSeconds: number): Date =>
	new Date((Math.floor(Date.now() / 1_000) + offsetSeconds) * 1_000);

databaseDescribe('durable gateway capability binding', () => {
	let database: Database;
	let hosts: HostService;
	let services: InternalRouteServices;
	let router: Router<InternalRouteServices>;
	let apiKeys: ApiKeyService;
	let regionId: string;
	let hostId: string;
	const deviceAuthorizationIds: string[] = [];
	const deviceFamilyIds: string[] = [];
	let issuerUsers: {
		a: { id: string; clerkUserId: string };
		b: { id: string; clerkUserId: string };
	};
	let target: { id: string; organizationId: string; projectId: string; leaseId: string };
	let otherProject: { id: string; organizationId: string; projectId: string; leaseId: string };
	let otherOrganization: {
		id: string;
		organizationId: string;
		projectId: string;
		leaseId: string;
	};

	const insertMachine = async (input: {
		id: string;
		organizationId: string;
		projectId: string;
		leaseId: string;
	}): Promise<void> => {
		await database.query(
			`INSERT INTO machines
			 (id, organization_id, project_id, host_id, host_machine_id, lease_id,
			  idempotency_key, idempotency_request_hash, state, region_id, architecture,
			  template_name, requested_ttl_seconds, vcpus, memory_mb, disk_mb, ready,
			  started_at, ready_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, 'x86_64',
			         'python', 900, 1, 512, 5120, true, now(), now(),
			         now() + interval '15 minutes')`,
			[
				input.id,
				input.organizationId,
				input.projectId,
				hostId,
				`local-${input.id.slice(-12)}`,
				input.leaseId,
				`gateway-${input.id}`,
				'a'.repeat(64),
				regionId
			]
		);
	};

	const insertGrant = async (
		machine: { id: string; organizationId: string; projectId: string; leaseId: string },
		capabilities: ReadonlyArray<GatewayCapability>,
		port: number | undefined,
		expiresAt: Date,
		createdAt = new Date(),
		issuer?: { type: 'api_key' | 'clerk_user' | 'device_family'; id: string }
	): Promise<string> => {
		const id = randomUUID();
		const boundIssuer =
			issuer ??
			(machine.organizationId === target.organizationId
				? { type: 'clerk_user' as const, id: issuerUsers.a.clerkUserId }
				: { type: 'clerk_user' as const, id: issuerUsers.b.clerkUserId });
		await database.query(
			`INSERT INTO machine_gateway_grants
			 (id, machine_id, organization_id, project_id, lease_id, capabilities, port,
			  expires_at, created_at, issuer_type, issuer_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[
				id,
				machine.id,
				machine.organizationId,
				machine.projectId,
				machine.leaseId,
				capabilities,
				port ?? null,
				expiresAt,
				createdAt,
				boundIssuer.type,
				boundIssuer.id
			]
		);
		return id;
	};

	const resolve = (
		machine: { id: string; organizationId: string; projectId: string; leaseId: string },
		input: {
			capability: GatewayCapability;
			capabilities: ReadonlyArray<GatewayCapability>;
			capabilityId: string;
			expiresAt: Date;
			port?: number;
			organizationId?: string;
			projectId?: string;
			leaseId?: string;
			streamId?: string;
			streamInstanceId?: string;
			streamBandwidth?: number;
			keepStream?: boolean;
		}
	): Promise<Response> => {
		const streamId = input.streamId ?? randomUUID();
		const streamInstanceId = input.streamInstanceId ?? 'gateway-test-a';
		const headers = new Headers({
			authorization: `Bearer ${gatewayServiceToken}`,
			'x-nehemiah-capability': input.capability,
			'x-nehemiah-capability-id': input.capabilityId,
			'x-nehemiah-capabilities': input.capabilities.join(','),
			'x-nehemiah-capability-organization-id': input.organizationId ?? machine.organizationId,
			'x-nehemiah-capability-project-id': input.projectId ?? machine.projectId,
			'x-nehemiah-capability-lease-id': input.leaseId ?? machine.leaseId,
			'x-nehemiah-capability-expires-at': input.expiresAt.toISOString(),
			'x-nehemiah-stream-id': streamId,
			'x-nehemiah-stream-instance-id': streamInstanceId,
			'x-nehemiah-stream-bandwidth-bytes-per-second': String(input.streamBandwidth ?? 1)
		});
		if (input.port !== undefined) headers.set('x-nehemiah-preview-port', String(input.port));
		return router
			.handle(
				new Request(`https://control.invalid/internal/v1/routing/machines/${machine.id}`, {
					headers
				}),
				services
			)
			.then(async (response) => {
				if (!input.keepStream && response.status === 200) {
					await services.streamAdmission!.release(streamId, streamInstanceId);
				}
				return response;
			});
	};

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		const suffix = randomUUID().replaceAll('-', '');
		regionId = `gateway-binding-${suffix}`;
		const organizationA = randomUUID();
		const organizationB = randomUUID();
		const projectA = randomUUID();
		const projectAOther = randomUUID();
		const projectB = randomUUID();
		issuerUsers = {
			a: { id: randomUUID(), clerkUserId: `gateway-issuer-a-${suffix}` },
			b: { id: randomUUID(), clerkUserId: `gateway-issuer-b-${suffix}` }
		};
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO regions (id, provider, display_name)
				 VALUES ($1, 'integration', 'Gateway binding integration')`,
				[regionId]
			);
			await client.query(
				`INSERT INTO organizations (id, slug, name)
				 VALUES ($1, $2, 'Gateway organization A'),
				        ($3, $4, 'Gateway organization B')`,
				[organizationA, `gateway-a-${suffix}`, organizationB, `gateway-b-${suffix}`]
			);
			await client.query(`INSERT INTO users (id, clerk_user_id) VALUES ($1, $2), ($3, $4)`, [
				issuerUsers.a.id,
				issuerUsers.a.clerkUserId,
				issuerUsers.b.id,
				issuerUsers.b.clerkUserId
			]);
			await client.query(
				`INSERT INTO organization_members (organization_id, user_id, role)
				 VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
				[organizationA, issuerUsers.a.id, organizationB, issuerUsers.b.id]
			);
			await client.query(
				`INSERT INTO projects (id, organization_id, slug, name)
				 VALUES ($1, $2, $3, 'Gateway project A'),
				        ($4, $2, $5, 'Gateway project A other'),
				        ($6, $7, $8, 'Gateway project B')`,
				[
					projectA,
					organizationA,
					`gateway-a-${suffix}`,
					projectAOther,
					`gateway-a-other-${suffix}`,
					projectB,
					organizationB,
					`gateway-b-${suffix}`
				]
			);
		});

		hosts = new HostService(database, new HostCredentialCipher(encodedKey), ['10.0.0.0/8']);
		const addressBytes = randomBytes(2);
		const hostInput = {
			providerId: `gateway-binding-${suffix}`,
			regionId,
			address: `10.254.${(addressBytes[0] ?? 0) % 250}.${((addressBytes[1] ?? 0) % 249) + 1}`,
			architecture: 'x86_64' as const,
			totalVcpus: 8,
			totalMemoryMb: 16_384,
			totalDiskMb: 100_000,
			controlToken: 'host-control-token-'.padEnd(48, 'c'),
			gatewayToken: hostGatewayToken,
			runtimeCohort: testRuntimeCohort
		};
		const enrollment = await hosts.issueEnrollment({
			providerId: hostInput.providerId,
			regionId: hostInput.regionId,
			address: hostInput.address,
			architecture: hostInput.architecture,
			totalVcpus: hostInput.totalVcpus,
			totalMemoryMb: hostInput.totalMemoryMb,
			totalDiskMb: hostInput.totalDiskMb,
			ttlSeconds: 600,
			issuedByOrganizationId: organizationA,
			issuedByUserId: 'gateway-binding-integration',
			runtimeCohort: testRuntimeCohort
		});
		const registered = await hosts.register(enrollment.token, hostInput);
		hostId = registered.id;
		expect(
			await hosts.heartbeat(
				hostId,
				{
					state: 'ready',
					availableVcpus: 8,
					availableMemoryMb: 16_384,
					availableDiskMb: 100_000,
					machineCount: 3,
					kvmAvailable: true,
					daemonVersion: 'gateway-binding-test',
					runtimeCohort: testRuntimeCohort
				},
				registered.credentialGeneration
			)
		).toBe(true);

		target = {
			id: machineId(),
			organizationId: organizationA,
			projectId: projectA,
			leaseId: randomUUID()
		};
		otherProject = {
			id: machineId(),
			organizationId: organizationA,
			projectId: projectAOther,
			leaseId: randomUUID()
		};
		otherOrganization = {
			id: machineId(),
			organizationId: organizationB,
			projectId: projectB,
			leaseId: randomUUID()
		};
		await insertMachine(target);
		await insertMachine(otherProject);
		await insertMachine(otherOrganization);

		apiKeys = new ApiKeyService(new PostgresApiKeyStore(database), 'test');
		services = {
			database,
			hosts,
			gatewayToken: gatewayServiceToken,
			apiKeys,
			streamAdmission: new StreamAdmissionService(database),
			audit: {} as AuditService,
			organizations: {} as OrganizationService
		};
		router = new Router<InternalRouteServices>();
		registerInternalHostRoutes(router);
	});

	it('serializes organization and project stream quotas across gateway instances', async () => {
		const expiresAt = secondTimestamp(120);
		const targetGrant = await insertGrant(target, ['files'], undefined, expiresAt);
		const otherGrant = await insertGrant(otherProject, ['files'], undefined, expiresAt);
		await database.query(
			`UPDATE organizations
			 SET max_gateway_streams = 2, max_gateway_bandwidth_bps = 200
			 WHERE id = $1`,
			[target.organizationId]
		);
		await database.query(
			`UPDATE projects
			 SET max_gateway_streams = CASE WHEN id = $2 THEN 1 ELSE 2 END,
			     max_gateway_bandwidth_bps = CASE WHEN id = $2 THEN 100 ELSE 200 END
			 WHERE organization_id = $1 AND id = ANY($3::uuid[])`,
			[target.organizationId, target.projectId, [target.projectId, otherProject.projectId]]
		);
		const base = {
			capability: 'files' as const,
			capabilities: ['files'] as const,
			expiresAt,
			streamBandwidth: 100,
			keepStream: true
		};
		const firstStream = randomUUID();
		try {
			const [first, sameProjectRace] = await Promise.all([
				resolve(target, {
					...base,
					capabilityId: targetGrant,
					streamId: firstStream,
					streamInstanceId: 'gateway-a'
				}),
				resolve(target, {
					...base,
					capabilityId: targetGrant,
					streamId: randomUUID(),
					streamInstanceId: 'gateway-b'
				})
			]);
			expect([first.status, sameProjectRace.status].sort()).toEqual([200, 429]);

			const other = await resolve(otherProject, {
				...base,
				capabilityId: otherGrant,
				streamId: randomUUID(),
				streamInstanceId: 'gateway-b'
			});
			expect(other.status).toBe(200);
			const organizationOverrun = await resolve(otherProject, {
				...base,
				capabilityId: otherGrant,
				streamId: randomUUID(),
				streamInstanceId: 'gateway-c'
			});
			expect(organizationOverrun.status).toBe(429);

			const replay = await resolve(target, {
				...base,
				capabilityId: targetGrant,
				streamId: firstStream,
				streamInstanceId: 'gateway-a'
			});
			if (first.status === 200) {
				expect(replay.status).toBe(200);
			} else {
				expect(replay.status).toBe(429);
			}
		} finally {
			await database.query('DELETE FROM gateway_stream_leases WHERE organization_id = $1', [
				target.organizationId
			]);
			await database.query(
				`UPDATE organizations
				 SET max_gateway_streams = 32, max_gateway_bandwidth_bps = 8388608
				 WHERE id = $1`,
				[target.organizationId]
			);
			await database.query(
				`UPDATE projects
				 SET max_gateway_streams = 32, max_gateway_bandwidth_bps = 8388608
				 WHERE organization_id = $1`,
				[target.organizationId]
			);
		}
	});

	it('globally rate-limits new capability resolutions while exempting exact active revalidation', async () => {
		const admission = new StreamAdmissionService(database, {
			windowSeconds: 60,
			authorityRequests: 2,
			projectRequests: 100,
			organizationRequests: 100
		});
		const authorityId = randomUUID();
		const first = {
			id: randomUUID(),
			organizationId: target.organizationId,
			projectId: target.projectId,
			authorityKind: 'machine_capability' as const,
			authorityId,
			instanceId: 'gateway-rate-a',
			bandwidthBytesPerSecond: 1
		};
		await admission.admitRouteRequest(first);
		await admission.acquire(first);
		// Periodic revalidation of the exact durable lease must not consume the
		// request budget or long-lived streams would rate-limit themselves.
		await expect(admission.admitRouteRequest(first)).resolves.toBeUndefined();
		await admission.release(first.id, first.instanceId);

		await admission.admitRouteRequest({ ...first, id: randomUUID() });
		await expect(admission.admitRouteRequest({ ...first, id: randomUUID() })).rejects.toMatchObject(
			{
				code: 'stream_request_rate_exceeded',
				retryAfterSeconds: expect.any(Number)
			}
		);
	});

	afterAll(async () => {
		if (!database) return;
		await database.query('DELETE FROM machines WHERE id = ANY($1::text[])', [
			[target?.id, otherProject?.id, otherOrganization?.id].filter(Boolean)
		]);
		if (deviceFamilyIds.length > 0) {
			await database.query('DELETE FROM device_refresh_families WHERE id = ANY($1::uuid[])', [
				deviceFamilyIds
			]);
		}
		if (deviceAuthorizationIds.length > 0) {
			await database.query('DELETE FROM device_authorizations WHERE id = ANY($1::uuid[])', [
				deviceAuthorizationIds
			]);
		}
		if (target?.organizationId) {
			await database.query('DELETE FROM api_keys WHERE organization_id = $1', [
				target.organizationId
			]);
		}
		if (hostId) await database.query('DELETE FROM hosts WHERE id = $1', [hostId]);
		if (regionId) await database.query('DELETE FROM regions WHERE id = $1', [regionId]);
		// Tenant/user rows remain because the API-key revocation audit ledger is
		// intentionally append-only and retains their foreign-key scope.
		await database.close();
	});

	it('requires an active exact grant for every signed field and current lease', async () => {
		const expiresAt = secondTimestamp(300);
		const capabilities = ['files', 'preview'] as const;
		const validGrant = await insertGrant(target, capabilities, 3_000, expiresAt);
		const validInput = {
			capability: 'preview' as const,
			capabilities,
			capabilityId: validGrant,
			port: 3_000,
			expiresAt
		};
		const valid = await resolve(target, validInput);
		expect(valid.status).toBe(200);
		expect(await valid.json()).toMatchObject({
			organization_id: target.organizationId,
			project_id: target.projectId,
			lease_id: target.leaseId,
			capability_id: validGrant,
			capabilities,
			capability_port: 3_000,
			capability_expires_at: expiresAt.toISOString(),
			host_token: hostGatewayToken
		});
		const oldGateway = await router.handle(
			new Request(`https://control.invalid/internal/v1/routing/machines/${target.id}`, {
				headers: {
					authorization: `Bearer ${gatewayServiceToken}`,
					'x-nehemiah-capability': 'preview',
					'x-nehemiah-capability-id': validGrant,
					'x-nehemiah-capabilities': capabilities.join(','),
					'x-nehemiah-capability-organization-id': target.organizationId,
					'x-nehemiah-capability-project-id': target.projectId,
					'x-nehemiah-capability-lease-id': target.leaseId,
					'x-nehemiah-capability-expires-at': expiresAt.toISOString(),
					'x-nehemiah-preview-port': '3000'
				}
			}),
			services
		);
		expect(oldGateway.status).toBe(400);
		const bypassLeases = await database.query<{ count: string }>(
			'SELECT count(*)::text AS count FROM gateway_stream_leases WHERE authority_id = $1',
			[validGrant]
		);
		expect(bypassLeases.rows[0]?.count).toBe('0');

		const projectGrant = await insertGrant(otherProject, capabilities, 3_000, expiresAt);
		const organizationGrant = await insertGrant(otherOrganization, capabilities, 3_000, expiresAt);
		const expiredAt = secondTimestamp(-60);
		const expiredGrant = await insertGrant(
			target,
			capabilities,
			3_000,
			expiredAt,
			secondTimestamp(-120)
		);
		for (const test of [
			{ name: 'unregistered jti', input: { ...validInput, capabilityId: randomUUID() } },
			{ name: 'cross-project grant', input: { ...validInput, capabilityId: projectGrant } },
			{
				name: 'cross-organization grant',
				input: { ...validInput, capabilityId: organizationGrant }
			},
			{ name: 'wrong organization claim', input: { ...validInput, organizationId: randomUUID() } },
			{ name: 'wrong project claim', input: { ...validInput, projectId: randomUUID() } },
			{ name: 'wrong lease claim', input: { ...validInput, leaseId: randomUUID() } },
			{
				name: 'wrong capability set',
				input: { ...validInput, capabilities: ['preview'] as const }
			},
			{ name: 'wrong port', input: { ...validInput, port: 3_001 } },
			{
				name: 'grant and token expiry mismatch',
				input: { ...validInput, expiresAt: new Date(expiresAt.getTime() - 1_000) }
			},
			{
				name: 'expired grant',
				input: { ...validInput, capabilityId: expiredGrant, expiresAt: expiredAt }
			}
		]) {
			const response = await resolve(target, test.input);
			expect(response.status, test.name).toBe(404);
		}

		await database.query(
			`UPDATE machine_gateway_grants SET revoked_at = statement_timestamp() WHERE id = $1`,
			[validGrant]
		);
		expect((await resolve(target, validInput)).status).toBe(404);

		const staleGrant = await insertGrant(target, capabilities, 3_000, expiresAt);
		const replacementLease = randomUUID();
		await database.query('UPDATE machines SET lease_id = $2 WHERE id = $1', [
			target.id,
			replacementLease
		]);
		expect((await resolve(target, { ...validInput, capabilityId: staleGrant })).status).toBe(404);

		target = { ...target, leaseId: replacementLease };
		const currentGrant = await insertGrant(target, capabilities, 3_000, expiresAt);
		const currentLease = await resolve(target, { ...validInput, capabilityId: currentGrant });
		expect(currentLease.status).toBe(200);
		expect(await currentLease.json()).toMatchObject({ lease_id: replacementLease });
		await database.query(
			"UPDATE machines SET state = 'stopping', ready = false, ready_at = NULL WHERE id = $1",
			[target.id]
		);
		expect((await resolve(target, { ...validInput, capabilityId: currentGrant })).status).toBe(404);
		await database.query(
			"UPDATE machines SET state = 'running', ready = true, ready_at = now() WHERE id = $1",
			[target.id]
		);
	});

	it('reaps expired grants in bounded oldest-first batches without deleting live grants', async () => {
		await database.query(
			'DELETE FROM machine_gateway_grants WHERE machine_id = $1 AND expires_at <= now()',
			[target.id]
		);
		// Epoch-old fixture rows are deterministically oldest even when the wider
		// integration suite runs concurrently against the same database.
		await insertGrant(
			target,
			['preview'],
			4_000,
			new Date('2020-01-01T00:01:00.000Z'),
			new Date('2020-01-01T00:00:00.000Z')
		);
		await insertGrant(
			target,
			['preview'],
			4_001,
			new Date('2020-01-01T00:03:00.000Z'),
			new Date('2020-01-01T00:02:00.000Z')
		);
		const liveGrant = await insertGrant(target, ['preview'], 4_002, secondTimestamp(60));

		expect(await reapExpiredGatewayGrants(database, 1)).toBe(1);
		const afterOne = await database.query<{ expired: string; live: string }>(
			`SELECT count(*) FILTER (WHERE expires_at <= now())::text AS expired,
			        count(*) FILTER (WHERE id = $1)::text AS live
			 FROM machine_gateway_grants WHERE machine_id = $2`,
			[liveGrant, target.id]
		);
		expect(afterOne.rows[0]).toEqual({ expired: '1', live: '1' });
		expect(await reapExpiredGatewayGrants(database, 1)).toBe(1);
		const remaining = await database.query<{ ids: string[] }>(
			'SELECT coalesce(array_agg(id::text), ARRAY[]::text[]) AS ids FROM machine_gateway_grants WHERE machine_id = $1',
			[target.id]
		);
		expect(remaining.rows[0]?.ids).toContain(liveGrant);
	});

	it('authorizes and replays an exact non-preview tty/files grant without a port', async () => {
		const expiresAt = secondTimestamp(120);
		const capabilities = ['tty', 'files'] as const;
		const grant = await insertGrant(target, capabilities, undefined, expiresAt);
		const input = { capability: 'files' as const, capabilities, capabilityId: grant, expiresAt };
		for (let replay = 0; replay < 2; replay += 1) {
			const response = await resolve(target, input);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				capability_id: grant,
				capabilities,
				organization_id: target.organizationId,
				project_id: target.projectId,
				lease_id: target.leaseId
			});
		}
		const tty = await resolve(target, { ...input, capability: 'tty' });
		expect(tty.status).toBe(200);
		expect((await tty.json()) as Record<string, unknown>).not.toHaveProperty('capability_port');
		expect((await resolve(target, { ...input, capabilityId: randomUUID() })).status).toBe(404);
	});

	it('fails closed when the issuing Clerk user loses machine-capable tenant membership', async () => {
		const expiresAt = secondTimestamp(120);
		const grant = await insertGrant(target, ['files'], undefined, expiresAt);
		const input = {
			capability: 'files' as const,
			capabilities: ['files'] as const,
			capabilityId: grant,
			expiresAt
		};
		expect((await resolve(target, input)).status).toBe(200);
		await database.query(
			"UPDATE organization_members SET role = 'billing' WHERE organization_id = $1 AND user_id = $2",
			[target.organizationId, issuerUsers.a.id]
		);
		expect((await resolve(target, input)).status).toBe(404);
		await database.query(
			"UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
			[target.organizationId, issuerUsers.a.id]
		);
		expect((await resolve(target, input)).status).toBe(200);
		await database.query(
			'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
			[target.organizationId, issuerUsers.a.id]
		);
		expect((await resolve(target, input)).status).toBe(404);
		await database.query(
			"INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
			[target.organizationId, issuerUsers.a.id]
		);
	});

	it('fails closed when a device-family approver loses machine-capable membership', async () => {
		const authorizationId = randomUUID();
		const familyId = randomUUID();
		deviceAuthorizationIds.push(authorizationId);
		deviceFamilyIds.push(familyId);
		await database.query(
			`INSERT INTO device_authorizations
			 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
			  approved_scopes, status, organization_id, project_id, approved_by,
			  expires_at, authorized_at, consumed_at)
			 VALUES ($1, $2, $3, 'gateway-binding-test', ARRAY['machines:write'],
			         ARRAY['machines:write'], 'consumed', $4, $5, $6,
			         now() + interval '10 minutes', now(), now())`,
			[
				authorizationId,
				randomBytes(32),
				randomBytes(32),
				target.organizationId,
				target.projectId,
				issuerUsers.a.id
			]
		);
		await database.query(
			`INSERT INTO device_refresh_families
			 (id, device_authorization_id, organization_id, project_id, scopes, expires_at)
			 VALUES ($1, $2, $3, $4, ARRAY['machines:write'], now() + interval '10 minutes')`,
			[familyId, authorizationId, target.organizationId, target.projectId]
		);
		const expiresAt = secondTimestamp(120);
		const grant = await insertGrant(target, ['tty'], undefined, expiresAt, new Date(), {
			type: 'device_family',
			id: familyId
		});
		const input = {
			capability: 'tty' as const,
			capabilities: ['tty'] as const,
			capabilityId: grant,
			expiresAt
		};
		expect((await resolve(target, input)).status).toBe(200);
		await database.query(
			"UPDATE organization_members SET role = 'billing' WHERE organization_id = $1 AND user_id = $2",
			[target.organizationId, issuerUsers.a.id]
		);
		expect((await resolve(target, input)).status).toBe(404);
		await database.query(
			"UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
			[target.organizationId, issuerUsers.a.id]
		);
		expect((await resolve(target, input)).status).toBe(200);
	});

	it('revoking an API key atomically revokes its outstanding gateway grants', async () => {
		const credential = await apiKeys.create({
			organizationId: target.organizationId,
			projectId: target.projectId,
			name: 'Gateway grant revocation integration',
			scopes: ['machines:write']
		});
		const expiresAt = secondTimestamp(120);
		const grant = await insertGrant(target, ['files'], undefined, expiresAt, new Date(), {
			type: 'api_key',
			id: credential.id
		});
		const input = {
			capability: 'files' as const,
			capabilities: ['files'] as const,
			capabilityId: grant,
			expiresAt
		};
		expect((await resolve(target, input)).status).toBe(200);
		expect(await apiKeys.revoke(credential.id, target.organizationId)).toBe(true);
		expect((await resolve(target, input)).status).toBe(404);
		const persisted = await database.query<{ revoked_at: Date | null }>(
			'SELECT revoked_at FROM machine_gateway_grants WHERE id = $1',
			[grant]
		);
		expect(persisted.rows[0]?.revoked_at).toBeInstanceOf(Date);
		expect(JSON.stringify(persisted.rows[0])).not.toContain(credential.key);
	});
});
