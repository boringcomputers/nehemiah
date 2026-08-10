import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyService } from '../src/auth/api-key.js';
import type { AuditOperation, AuditRecord, AuditService } from '../src/audit/audit.js';
import type { Queryable } from '../src/db/client.js';
import { HostCredentialCipher } from '../src/domain/host-credentials.js';
import { HostService, type HostLifecycle } from '../src/domain/hosts.js';
import type { OrganizationService } from '../src/domain/organizations.js';
import { Router } from '../src/http/router.js';
import {
	registerInternalHostRoutes,
	type InternalRouteServices
} from '../src/http/routes/internal-hosts.js';
import { testRuntimeCohort, testRuntimeCohortWire } from './runtime-cohort-fixture.js';

const encodedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const controlToken = 'control-token-with-more-than-thirty-two-random-characters';
const gatewayToken = 'gateway-token-with-more-than-thirty-two-random-characters';

const lifecycle = (overrides: Partial<HostLifecycle> = {}): HostLifecycle => ({
	id: '9a810a45-9842-4b97-a9ef-d1a5b9821642',
	desiredState: 'active',
	credentialGeneration: 2,
	credentialStatus: 'active',
	credentialRotatedAt: new Date('2026-08-09T01:00:00.000Z'),
	...overrides
});

describe('host lifecycle persistence', () => {
	it('rejects collapsed control and gateway authority before changing host state', async () => {
		const query = vi.fn();
		const hosts = new HostService(
			{ query } as unknown as Queryable,
			new HostCredentialCipher(encodedKey)
		);
		const shared = 'shared-host-authority-token'.padEnd(48, 'x');

		await expect(
			hosts.rotateCredentials(lifecycle().id, { controlToken: shared, gatewayToken: shared })
		).rejects.toMatchObject({ code: 'invalid_host_enrollment' });
		expect(query).not.toHaveBeenCalled();
	});

	it('does not let a heartbeat revive stale or override control-plane desired state', async () => {
		let statement = '';
		const database: Queryable = {
			query: async (text) => {
				statement = text;
				return { rows: [], rowCount: 0 } as never;
			}
		};
		const hosts = new HostService(database, new HostCredentialCipher(encodedKey));

		const accepted = await hosts.heartbeat(
			lifecycle().id,
			{
				state: 'ready',
				availableVcpus: 8,
				availableMemoryMb: 16_384,
				availableDiskMb: 100_000,
				machineCount: 0,
				kvmAvailable: true,
				daemonVersion: 'test',
				runtimeCohort: testRuntimeCohort
			},
			1
		);

		expect(accepted).toBe(false);
		expect(statement).toContain("WHERE id = $1 AND state <> 'stale'");
		expect(statement).toContain("desired_state IN ('active', 'draining')");
		expect(statement).toContain("credential_status = 'active'");
		expect(statement).toContain('credential_generation = $9');
		expect(statement).toContain("host.desired_state = 'draining'");
	});

	it('clears every stored credential on quarantine and rotates to a new generation', async () => {
		const calls: Array<{ text: string; values: ReadonlyArray<unknown> }> = [];
		const database: Queryable = {
			query: async (text, values = []) => {
				calls.push({ text, values });
				const quarantining = text.includes("SET desired_state = 'quarantined'");
				return {
					rows: [
						{
							id: lifecycle().id,
							desired_state: quarantining ? 'quarantined' : 'draining',
							credential_generation: quarantining ? 1 : 2,
							credential_status: quarantining ? 'revoked' : 'active',
							credential_rotated_at: new Date('2026-08-09T01:00:00.000Z'),
							credential_revoked_at: quarantining ? new Date('2026-08-09T02:00:00.000Z') : null,
							lifecycle_reason: 'test'
						}
					],
					rowCount: 1
				} as never;
			}
		};
		const hosts = new HostService(database, new HostCredentialCipher(encodedKey));

		const quarantined = await hosts.quarantine(lifecycle().id, 'suspected compromise');
		expect(quarantined?.credentialStatus).toBe('revoked');
		expect(calls[0]?.text).toContain('credential_hash = NULL');
		expect(calls[0]?.text).toContain('control_credential_ciphertext = NULL');
		expect(calls[0]?.text).toContain('gateway_credential_ciphertext = NULL');

		const rotated = await hosts.rotateCredentials(
			lifecycle().id,
			{ controlToken, gatewayToken },
			'incident recovery'
		);
		expect(rotated).toMatchObject({
			desiredState: 'draining',
			credentialGeneration: 2,
			credentialStatus: 'active'
		});
		expect(rotated?.credential).toMatch(/^nh_[a-f0-9]{64}$/);
		expect(calls[1]?.text).toContain('credential_generation = credential_generation + 1');
		expect(calls[1]?.text).toContain("ELSE 'draining'::host_desired_state");
		expect(calls[1]?.text).toContain("desired_state <> 'revoked'");
		expect(JSON.stringify(calls)).not.toContain(controlToken);
		expect(JSON.stringify(calls)).not.toContain(gatewayToken);
	});

	it('makes all credential readers fail closed on lifecycle state and status', async () => {
		const statements: string[] = [];
		const database: Queryable = {
			query: async (text) => {
				statements.push(text);
				return { rows: [], rowCount: 0 } as never;
			}
		};
		const hosts = new HostService(database, new HostCredentialCipher(encodedKey));

		expect(await hosts.authenticate(lifecycle().id, 'invalid')).toBe(false);
		expect(await hosts.gatewayCredential(lifecycle().id)).toBeUndefined();
		for (const statement of statements) {
			expect(statement).toContain("desired_state IN ('active', 'draining')");
			expect(statement).toContain("credential_status = 'active'");
			expect(statement).toContain("state <> 'stale'");
		}
	});
});

class CapturingAudit {
	readonly records: AuditRecord[] = [];
	readonly operations: Array<AuditOperation<unknown>> = [];

	async record(input: AuditRecord) {
		this.records.push(input);
		return { eventKey: 'audit-event', operationId: 'audit-operation' };
	}

	async capture<T>(input: AuditOperation<T>, operation: () => Promise<T>): Promise<T> {
		this.operations.push(input as AuditOperation<unknown>);
		return operation();
	}
}

const routeServices = (input: {
	role: 'owner' | 'admin' | 'member' | 'billing';
	operatorOrganization: boolean;
	apiKey?: boolean;
}) => {
	const audit = new CapturingAudit();
	const drain = vi.fn(async () => lifecycle({ desiredState: 'draining' }));
	const rotateCredentials = vi.fn(async () => ({
		...lifecycle({ desiredState: 'draining' }),
		credential: 'nh_new-secret'
	}));
	const issueEnrollment = vi.fn(async () => ({
		id: 'be909135-b03e-474e-9252-e3ca5ac9cf88',
		hostId: '50373d19-e624-46c6-a5e5-26fb13d691ac',
		token: `nhe_${'a'.repeat(43)}`,
		expiresAt: new Date('2026-08-09T01:10:00.000Z')
	}));
	const register = vi.fn(async () => ({
		id: lifecycle().id,
		grantId: 'be909135-b03e-474e-9252-e3ca5ac9cf88',
		credential: 'nh_registered-secret',
		credentialGeneration: 1
	}));
	const hosts = {
		isOperatorOrganization: vi.fn(async () => input.operatorOrganization),
		issueEnrollment,
		revokeEnrollment: vi.fn(async () => true),
		register,
		drain,
		activate: vi.fn(),
		quarantine: vi.fn(),
		revoke: vi.fn(),
		rotateCredentials
	} as unknown as HostService;
	const services: InternalRouteServices = {
		apiKeys: {
			authenticate: async () =>
				input.apiKey
					? {
							kind: 'api_key',
							apiKeyId: 'api-key',
							organizationId: 'operator-org',
							scopes: new Set(['machines:write'])
						}
					: undefined
		} as unknown as ApiKeyService,
		audit: audit as unknown as AuditService,
		organizations: {
			membershipRole: async () => input.role
		} as unknown as OrganizationService,
		clerkSessionVerifier: async () => ({ sub: 'operator-user', org_id: 'operator-org' }),
		database: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable,
		hosts,
		gatewayToken: 'gateway'
	};
	return { services, audit, drain, rotateCredentials, issueEnrollment, register };
};

const hostRouter = (): Router<InternalRouteServices> => {
	const router = new Router<InternalRouteServices>();
	registerInternalHostRoutes(router);
	return router;
};

const operatorRequest = (path: string, token = 'clerk-session', body: unknown = {}) =>
	new Request(`https://api.example.com${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

describe('private fleet operator routes', () => {
	it('passes the opaque enrollment grant into host registration without auditing secrets', async () => {
		const fixture = routeServices({ role: 'admin', operatorOrganization: true });
		const enrollmentToken = `nhe_${'b'.repeat(43)}`;
		const response = await hostRouter().handle(
			operatorRequest('/internal/v1/hosts/register', enrollmentToken, {
				provider_id: 'latitude-yyz-001',
				region_id: 'ca-tor-1',
				address: '10.64.0.9',
				architecture: 'x86_64',
				control_token: 'control-token-'.padEnd(40, 'c'),
				gateway_token: 'gateway-token-'.padEnd(40, 'g'),
				total_vcpus: 8,
				total_memory_mb: 16384,
				total_disk_mb: 100000,
				runtime_cohort: testRuntimeCohortWire
			}),
			fixture.services
		);

		expect(response.status).toBe(201);
		expect(fixture.register).toHaveBeenCalledWith(
			enrollmentToken,
			expect.objectContaining({ providerId: 'latitude-yyz-001', address: '10.64.0.9' })
		);
		expect(JSON.stringify(fixture.audit.operations)).not.toContain(enrollmentToken);
	});

	it('does not accept the retired fleet-global bootstrap bearer', async () => {
		const fixture = routeServices({ role: 'admin', operatorOrganization: true });
		const response = await hostRouter().handle(
			operatorRequest('/internal/v1/hosts/register', 'fleet-bootstrap', {}),
			fixture.services
		);

		expect(response.status).toBe(401);
		expect(fixture.register).not.toHaveBeenCalled();
	});

	it('issues a short-lived identity-bound enrollment grant exactly once to an operator', async () => {
		const fixture = routeServices({ role: 'admin', operatorOrganization: true });
		const response = await hostRouter().handle(
			operatorRequest('/v1/operator/host-enrollments', 'clerk-session', {
				provider_id: 'latitude-yyz-001',
				region_id: 'ca-tor-1',
				address: '10.64.0.9',
				architecture: 'x86_64',
				total_vcpus: 8,
				total_memory_mb: 16384,
				total_disk_mb: 100000,
				ttl_seconds: 600,
				runtime_cohort: testRuntimeCohortWire
			}),
			fixture.services
		);

		expect(response.status).toBe(201);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(fixture.issueEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: 'latitude-yyz-001',
				address: '10.64.0.9',
				issuedByOrganizationId: 'operator-org',
				issuedByUserId: 'operator-user'
			})
		);
		expect(await response.json()).toMatchObject({
			host_id: '50373d19-e624-46c6-a5e5-26fb13d691ac',
			token: `nhe_${'a'.repeat(43)}`,
			secret_displayed_once: true
		});
		expect(JSON.stringify(fixture.audit.operations)).not.toContain(`nhe_${'a'.repeat(43)}`);
	});

	it('lets an allowlisted owner drain a host and audits the operation', async () => {
		const fixture = routeServices({ role: 'owner', operatorOrganization: true });
		const response = await hostRouter().handle(
			operatorRequest(`/v1/operator/hosts/${lifecycle().id}/drain`, 'clerk-session', {
				reason: 'scheduled maintenance'
			}),
			fixture.services
		);

		expect(response.status).toBe(200);
		expect(fixture.drain).toHaveBeenCalledWith(lifecycle().id, 'scheduled maintenance');
		expect(fixture.audit.operations[0]?.action).toBe('host.drain');
		expect(await response.json()).toMatchObject({
			host: { desired_state: 'draining', credential_status: 'active' }
		});
	});

	it.each([
		['member', true, 'clerk-session'],
		['admin', false, 'clerk-session'],
		['admin', true, 'bc_test_operator_key']
	] as const)(
		'denies role=%s allowlisted=%s token=%s',
		async (role, operatorOrganization, token) => {
			const fixture = routeServices({
				role,
				operatorOrganization,
				apiKey: token.startsWith('bc_')
			});
			const response = await hostRouter().handle(
				operatorRequest(`/v1/operator/hosts/${lifecycle().id}/drain`, token),
				fixture.services
			);

			expect(response.status).toBe(403);
			expect(fixture.drain).not.toHaveBeenCalled();
			expect(fixture.audit.records[0]).toMatchObject({
				action: 'host.drain',
				outcome: 'denied',
				reasonCode: 'fleet_operator_required'
			});
		}
	);

	it('rotates all host credentials, returns the host credential once, and never audits secrets', async () => {
		const fixture = routeServices({ role: 'admin', operatorOrganization: true });
		const response = await hostRouter().handle(
			operatorRequest(`/v1/operator/hosts/${lifecycle().id}/credentials/rotate`, 'clerk-session', {
				control_token: controlToken,
				gateway_token: gatewayToken,
				reason: 'scheduled rotation'
			}),
			fixture.services
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({
			credential: 'nh_new-secret',
			secret_displayed_once: true,
			host: { credential_generation: 2, credential_status: 'active' }
		});
		expect(JSON.stringify(fixture.audit.operations)).not.toContain(controlToken);
		expect(JSON.stringify(fixture.audit.operations)).not.toContain(gatewayToken);
	});

	it('returns a typed client error before rotating equal control and gateway credentials', async () => {
		const fixture = routeServices({ role: 'admin', operatorOrganization: true });
		const shared = 'collapsed-host-authority'.padEnd(48, 'x');
		const response = await hostRouter().handle(
			operatorRequest(`/v1/operator/hosts/${lifecycle().id}/credentials/rotate`, 'clerk-session', {
				control_token: shared,
				gateway_token: shared
			}),
			fixture.services
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ title: 'invalid_host_credential_rotation' });
		expect(fixture.rotateCredentials).not.toHaveBeenCalled();
	});
});
