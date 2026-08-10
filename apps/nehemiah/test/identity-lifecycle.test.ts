import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyService } from '../src/auth/api-key.js';
import type { AuditRecord, AuditService } from '../src/audit/audit.js';
import {
	IdentityLifecycleAuthorizationDenied,
	IdentityProviderSyncConflict,
	IdentityProviderSyncTargetNotFound,
	type IdentityLifecycleService
} from '../src/domain/identity-lifecycle.js';
import type { HostService } from '../src/domain/hosts.js';
import type { OrganizationService } from '../src/domain/organizations.js';
import { Router } from '../src/http/router.js';
import {
	registerIdentityLifecycleRoutes,
	type IdentityLifecycleRouteServices
} from '../src/http/routes/identity-lifecycle.js';

const userId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';

class CapturingAudit {
	readonly records: AuditRecord[] = [];

	async record(input: AuditRecord) {
		this.records.push(input);
		return { eventKey: 'audit-event', operationId: 'audit-operation' };
	}
}

const fixture = (
	input: {
		readonly role?: 'owner' | 'admin' | 'member' | 'billing';
		readonly operator?: boolean;
	} = {}
) => {
	const audit = new CapturingAudit();
	const disableUser = vi.fn(async () => ({
		id: userId,
		disabledAt: new Date('2026-08-09T12:00:00.000Z'),
		changed: true
	}));
	const enableUser = vi.fn(async () => ({ id: userId, changed: true }));
	const disableOrganization = vi.fn(async () => ({
		id: organizationId,
		disabledAt: new Date('2026-08-09T12:00:00.000Z'),
		changed: true
	}));
	const enableOrganization = vi.fn(async () => ({ id: organizationId, changed: true }));
	const syncIdentityProvider = vi.fn(async () => ({
		provider: 'clerk' as const,
		eventId: 'evt_membership_42',
		sourceVersion: 42,
		result: 'applied' as const,
		changed: true,
		userId,
		organizationId
	}));
	const services: IdentityLifecycleRouteServices = {
		apiKeys: { authenticate: async () => undefined } as unknown as ApiKeyService,
		audit: audit as unknown as AuditService,
		organizations: {
			membershipRole: async () => input.role ?? 'admin'
		} as unknown as OrganizationService,
		clerkSessionVerifier: async () => ({ sub: 'operator-user', org_id: 'operator-org' }),
		hosts: {
			isOperatorOrganization: vi.fn(async () => input.operator ?? true)
		} as unknown as HostService,
		identityLifecycle: {
			disableUser,
			enableUser,
			disableOrganization,
			enableOrganization,
			syncIdentityProvider
		} as unknown as IdentityLifecycleService
	};
	const router = new Router<IdentityLifecycleRouteServices>();
	registerIdentityLifecycleRoutes(router);
	return {
		audit,
		disableUser,
		enableUser,
		disableOrganization,
		enableOrganization,
		syncIdentityProvider,
		handle: (path: string, body: string, authorized = true) =>
			router.handle(
				new Request(`https://api.example.test${path}`, {
					method: 'POST',
					headers: {
						...(authorized ? { authorization: 'Bearer clerk-session' } : {}),
						'content-type': 'application/json'
					},
					body
				}),
				services
			)
	};
};

describe('operator identity lifecycle routes', () => {
	it('requires a current fleet-operator owner or administrator', async () => {
		const unauthorized = fixture();
		expect(
			(
				await unauthorized.handle(
					`/v1/operator/users/${userId}/disable`,
					JSON.stringify({ reason: 'incident response' }),
					false
				)
			).status
		).toBe(401);
		expect(unauthorized.disableUser).not.toHaveBeenCalled();

		const nonOperator = fixture({ role: 'member', operator: false });
		const response = await nonOperator.handle(
			`/v1/operator/users/${userId}/disable`,
			JSON.stringify({ reason: 'incident response' })
		);
		expect(response.status).toBe(403);
		expect(nonOperator.disableUser).not.toHaveBeenCalled();
		expect(nonOperator.audit.records).toContainEqual(
			expect.objectContaining({
				action: 'identity.user.disable',
				outcome: 'denied',
				reasonCode: 'fleet_operator_required',
				resourceId: userId
			})
		);
	});

	it('forwards a bounded reason and operator identity to the atomic service', async () => {
		const target = fixture();
		const response = await target.handle(
			`/v1/operator/users/${userId}/disable`,
			JSON.stringify({ reason: '  confirmed compromise  ' })
		);

		expect(response.status).toBe(200);
		expect(target.disableUser).toHaveBeenCalledWith(
			userId,
			expect.objectContaining({
				actorType: 'user',
				actorId: 'operator-user',
				actorOrganizationId: 'operator-org',
				reason: 'confirmed compromise'
			})
		);
		expect(await response.json()).toEqual({
			user: { id: userId, disabled_at: '2026-08-09T12:00:00.000Z' },
			changed: true
		});
	});

	it('fails closed on invalid IDs, malformed reasons, and oversized bodies', async () => {
		const target = fixture();
		for (const [path, body, status] of [
			['/v1/operator/users/not-a-uuid/disable', JSON.stringify({ reason: 'incident' }), 400],
			[`/v1/operator/users/${userId}/disable`, JSON.stringify({ reason: '', extra: true }), 400],
			[`/v1/operator/users/${userId}/disable`, JSON.stringify({ reason: 'x'.repeat(4_097) }), 413]
		] as const) {
			expect((await target.handle(path, body)).status).toBe(status);
		}
		expect(target.disableUser).not.toHaveBeenCalled();
	});

	it('routes organization enable to the matching audited lifecycle transition', async () => {
		const target = fixture({ role: 'owner' });
		const response = await target.handle(
			`/v1/operator/organizations/${organizationId}/enable`,
			JSON.stringify({ reason: 'appeal approved' })
		);

		expect(response.status).toBe(200);
		expect(target.enableOrganization).toHaveBeenCalledWith(
			organizationId,
			expect.objectContaining({ reason: 'appeal approved', actorId: 'operator-user' })
		);
		expect(await response.json()).toEqual({
			organization: { id: organizationId },
			changed: true
		});
	});

	it('accepts the bounded provider event contract and returns no external subject', async () => {
		const target = fixture({ role: 'owner' });
		const response = await target.handle(
			'/v1/operator/identity-provider/sync',
			JSON.stringify({
				provider: 'clerk',
				event_id: 'evt_membership_42',
				source_version: 42,
				event_type: 'membership.upserted',
				clerk_user_id: 'user_target_42',
				organization_id: organizationId,
				role: 'member',
				reason: 'provider reconciliation'
			})
		);

		expect(response.status).toBe(200);
		expect(target.syncIdentityProvider).toHaveBeenCalledWith(
			{
				provider: 'clerk',
				eventId: 'evt_membership_42',
				sourceVersion: 42,
				eventType: 'membership.upserted',
				clerkUserId: 'user_target_42',
				organizationId,
				role: 'member'
			},
			expect.objectContaining({
				actorId: 'operator-user',
				actorOrganizationId: 'operator-org',
				reason: 'provider reconciliation'
			})
		);
		expect(await response.json()).toEqual({
			provider: 'clerk',
			event_id: 'evt_membership_42',
			source_version: 42,
			result: 'applied',
			changed: true,
			user_id: userId,
			organization_id: organizationId
		});
	});

	it('audits and rejects unknown event shapes, roles, extra fields, and oversized bodies', async () => {
		const target = fixture();
		const base = {
			provider: 'clerk',
			event_id: 'evt_invalid_1',
			source_version: 1,
			event_type: 'membership.upserted',
			clerk_user_id: 'user_target_1',
			organization_id: organizationId,
			role: 'member',
			reason: 'provider reconciliation'
		};
		for (const body of [
			{ ...base, event_type: 'membership.unknown' },
			{ ...base, role: 'superadmin' },
			{ ...base, unexpected: true }
		]) {
			expect(
				(await target.handle('/v1/operator/identity-provider/sync', JSON.stringify(body))).status
			).toBe(400);
		}
		expect(
			(
				await target.handle(
					'/v1/operator/identity-provider/sync',
					JSON.stringify({ ...base, reason: 'x'.repeat(16_384) })
				)
			).status
		).toBe(413);
		expect(target.syncIdentityProvider).not.toHaveBeenCalled();
		expect(target.audit.records).toHaveLength(4);
		expect(target.audit.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: 'identity.provider.sync',
					outcome: 'denied',
					resourceId: 'unparsed'
				})
			])
		);
	});

	it('maps transaction-time provider target, conflict, and actor failures to typed responses', async () => {
		const body = JSON.stringify({
			provider: 'clerk',
			event_id: 'evt_failure_1',
			source_version: 1,
			event_type: 'user.disabled',
			clerk_user_id: 'user_target_1',
			reason: 'provider reconciliation'
		});
		for (const [error, status, title] of [
			[new IdentityLifecycleAuthorizationDenied(), 403, 'fleet_operator_required'],
			[new IdentityProviderSyncTargetNotFound(), 404, 'identity_provider_target_not_found'],
			[new IdentityProviderSyncConflict(), 409, 'identity_provider_sync_conflict']
		] as const) {
			const target = fixture();
			target.syncIdentityProvider.mockRejectedValueOnce(error);
			const response = await target.handle('/v1/operator/identity-provider/sync', body);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ title });
		}
	});
});
