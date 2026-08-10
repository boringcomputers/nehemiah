import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeyService } from '../../src/auth/api-key.js';
import { AuditService } from '../../src/audit/audit.js';
import { Database } from '../../src/db/client.js';
import {
	IdentityLifecycleAuthorizationDenied,
	IdentityLifecycleService,
	IdentityProviderSyncConflict,
	IdentityProviderSyncTargetNotFound,
	type IdentityLifecycleContext,
	type IdentityProviderSyncInput
} from '../../src/domain/identity-lifecycle.js';
import { HostService } from '../../src/domain/hosts.js';
import { OrganizationService } from '../../src/domain/organizations.js';
import { canAdminister } from '../../src/http/auth.js';
import { Router } from '../../src/http/router.js';
import {
	registerIdentityLifecycleRoutes,
	type IdentityLifecycleRouteServices
} from '../../src/http/routes/identity-lifecycle.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

interface Tenant {
	readonly organizationId: string;
	readonly projectId: string;
	readonly userId: string;
	readonly clerkUserId: string;
}

databaseDescribe('ordered Clerk identity-provider synchronization', () => {
	let database: Database;
	let identities: IdentityLifecycleService;
	let operator: Tenant;

	const seedTenant = async (label: string, role = 'owner'): Promise<Tenant> => {
		const suffix = randomUUID().replaceAll('-', '');
		const tenant = {
			organizationId: randomUUID(),
			projectId: randomUUID(),
			userId: randomUUID(),
			clerkUserId: `${label}_${suffix}`
		};
		await database.transaction(async (client) => {
			await client.query('INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)', [
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
				 VALUES ($1, $2, $3)`,
				[tenant.organizationId, tenant.userId, role]
			);
		});
		return tenant;
	};

	const context = (actor = operator): IdentityLifecycleContext => ({
		actorType: 'user',
		actorId: actor.clerkUserId,
		actorOrganizationId: actor.organizationId,
		reason: 'explicit provider reconciliation',
		requestId: `sync-${randomUUID()}`,
		userAgent: 'identity-provider-sync-integration'
	});

	const event = (
		target: Tenant,
		input: Omit<IdentityProviderSyncInput, 'provider' | 'clerkUserId'>
	): IdentityProviderSyncInput => ({
		provider: 'clerk',
		clerkUserId: target.clerkUserId,
		...input
	});

	beforeAll(async () => {
		database = new Database(databaseUrl!);
		identities = new IdentityLifecycleService(database);
		operator = await seedTenant('sync-operator');
		await database.query('INSERT INTO fleet_operator_organizations (organization_id) VALUES ($1)', [
			operator.organizationId
		]);
	});

	afterAll(async () => {
		await database?.close();
	});

	it('applies in source order, classifies replay/stale/conflicts, and retains only bounded evidence', async () => {
		const target = await seedTenant('sync-user');
		const appliedEvent = event(target, {
			eventId: `evt_${randomUUID().replaceAll('-', '')}`,
			sourceVersion: 10,
			eventType: 'user.disabled'
		});
		const concurrent = await Promise.all([
			identities.syncIdentityProvider(appliedEvent, context()),
			identities.syncIdentityProvider(appliedEvent, context())
		]);
		const applied = concurrent.find(({ result }) => result === 'applied');
		expect(applied).toMatchObject({ result: 'applied', changed: true, userId: target.userId });
		const replayed = concurrent.find(({ result }) => result === 'replayed');
		expect(replayed).toMatchObject({ result: 'replayed', changed: true });

		const stale = await identities.syncIdentityProvider(
			event(target, {
				eventId: `evt_${randomUUID().replaceAll('-', '')}`,
				sourceVersion: 9,
				eventType: 'user.deleted'
			}),
			context()
		);
		expect(stale).toMatchObject({ result: 'stale', changed: false });

		await expect(
			identities.syncIdentityProvider({ ...appliedEvent, eventType: 'user.deleted' }, context())
		).rejects.toBeInstanceOf(IdentityProviderSyncConflict);
		await expect(
			identities.syncIdentityProvider(
				event(target, {
					eventId: `evt_${randomUUID().replaceAll('-', '')}`,
					sourceVersion: 10,
					eventType: 'user.deleted'
				}),
				context()
			)
		).rejects.toBeInstanceOf(IdentityProviderSyncConflict);

		const state = await database.query<{ disabled_at: Date | null }>(
			'SELECT disabled_at FROM users WHERE id = $1',
			[target.userId]
		);
		expect(state.rows[0]?.disabled_at).toBeInstanceOf(Date);
		const receipts = await database.query<Record<string, unknown>>(
			`SELECT * FROM identity_provider_sync_receipts WHERE user_id = $1
			 ORDER BY source_version`,
			[target.userId]
		);
		expect(receipts.rows).toHaveLength(2);
		expect(receipts.rows.map(({ result }) => result)).toEqual(['stale', 'applied']);
		expect(JSON.stringify(receipts.rows)).not.toContain(target.clerkUserId);

		const audits = await database.query<{
			outcome: string;
			reason_code: string | null;
			metadata: Record<string, unknown>;
		}>(
			`SELECT outcome, reason_code, metadata FROM audit_events
			 WHERE action = 'identity.provider.sync'
			   AND resource_id = ANY($1::text[])
			 ORDER BY id`,
			[
				[
					appliedEvent.eventId,
					...receipts.rows
						.map(({ event_id }) => event_id)
						.filter((value): value is string => typeof value === 'string')
				]
			]
		);
		expect(audits.rows.map(({ outcome }) => outcome)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'denied'
		]);
		expect(audits.rows.map(({ metadata }) => metadata.sync_result).filter(Boolean)).toEqual([
			'applied',
			'replayed',
			'stale'
		]);
		expect(JSON.stringify(audits.rows)).not.toContain(target.clerkUserId);
		expect(JSON.stringify(audits.rows)).not.toContain('explicit provider reconciliation');

		await expect(
			database.query('UPDATE users SET clerk_user_id = $2 WHERE id = $1', [
				target.userId,
				`replacement_${randomUUID().replaceAll('-', '')}`
			])
		).rejects.toThrow(/immutable/i);
		await expect(
			database.query(
				`UPDATE identity_provider_sync_receipts SET changed = false
				 WHERE provider = 'clerk' AND event_id = $1`,
				[appliedEvent.eventId]
			)
		).rejects.toThrow(/append-only/i);

		const deletedTarget = await seedTenant('sync-deleted-user');
		expect(
			await identities.syncIdentityProvider(
				event(deletedTarget, {
					eventId: `evt_${randomUUID().replaceAll('-', '')}`,
					sourceVersion: 1,
					eventType: 'user.deleted'
				}),
				context()
			)
		).toMatchObject({ result: 'applied', changed: true });
		const deletedState = await database.query<{ disabled_at: Date | null }>(
			'SELECT disabled_at FROM users WHERE id = $1',
			[deletedTarget.userId]
		);
		expect(deletedState.rows[0]?.disabled_at).toBeInstanceOf(Date);
	});

	it('applies membership desired state, makes downgrade immediate, and revokes dependents on removal', async () => {
		const target = await seedTenant('sync-member');
		await database.query('INSERT INTO fleet_operator_organizations (organization_id) VALUES ($1)', [
			target.organizationId
		]);
		await database.query(
			'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
			[target.organizationId, target.userId]
		);
		const upsert = (version: number, role: 'owner' | 'admin' | 'member' | 'billing') =>
			identities.syncIdentityProvider(
				event(target, {
					eventId: `evt_${randomUUID().replaceAll('-', '')}`,
					sourceVersion: version,
					eventType: 'membership.upserted',
					organizationId: target.organizationId,
					role
				}),
				context()
			);
		expect(await upsert(1, 'owner')).toMatchObject({ result: 'applied', changed: true });

		const authorizationId = randomUUID();
		const familyId = randomUUID();
		const accessId = randomUUID();
		await database.transaction(async (client) => {
			await client.query(
				`INSERT INTO device_authorizations
				 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
				  approved_scopes, status, organization_id, project_id, approved_by,
				  expires_at, authorized_at, consumed_at)
				 VALUES ($1, $2, $3, 'provider-sync-test', ARRAY['machines:read'],
				         ARRAY['machines:read'], 'consumed', $4, $5, $6,
				         now() + interval '1 hour', now(), now())`,
				[
					authorizationId,
					createHash('sha256').update(randomUUID()).digest(),
					createHash('sha256').update(randomUUID()).digest(),
					target.organizationId,
					target.projectId,
					target.userId
				]
			);
			await client.query(
				`INSERT INTO device_refresh_families
				 (id, device_authorization_id, organization_id, project_id, scopes, expires_at)
				 VALUES ($1, $2, $3, $4, ARRAY['machines:read'], now() + interval '1 day')`,
				[familyId, authorizationId, target.organizationId, target.projectId]
			);
			await client.query(
				`INSERT INTO device_access_tokens
				 (id, family_id, organization_id, project_id, scopes, token_hash, expires_at)
				 VALUES ($1, $2, $3, $4, ARRAY['machines:read'], $5, now() + interval '15 minutes')`,
				[
					accessId,
					familyId,
					target.organizationId,
					target.projectId,
					createHash('sha256').update(randomUUID()).digest()
				]
			);
		});

		expect(await upsert(2, 'member')).toMatchObject({ result: 'applied', changed: true });
		const organizations = new OrganizationService(database);
		const currentRole = await organizations.membershipRole(
			target.clerkUserId,
			target.organizationId
		);
		expect(currentRole).toBe('member');
		expect(
			canAdminister({
				kind: 'user',
				clerkUserId: target.clerkUserId,
				organizationId: target.organizationId,
				role: currentRole!,
				claims: { sub: target.clerkUserId, org_id: target.organizationId }
			})
		).toBe(false);
		const route = new Router<IdentityLifecycleRouteServices>();
		registerIdentityLifecycleRoutes(route);
		const downgradedResponse = await route.handle(
			new Request('https://api.example.test/v1/operator/identity-provider/sync', {
				method: 'POST',
				headers: { authorization: 'Bearer downgraded-session' },
				body: '{}'
			}),
			{
				apiKeys: { authenticate: async () => undefined } as unknown as ApiKeyService,
				audit: new AuditService(database),
				organizations,
				clerkSessionVerifier: async () => ({
					sub: target.clerkUserId,
					org_id: target.organizationId
				}),
				hosts: new HostService(database),
				identityLifecycle: identities
			}
		);
		expect(downgradedResponse.status).toBe(403);
		expect(await downgradedResponse.json()).toMatchObject({ title: 'fleet_operator_required' });
		expect(await upsert(3, 'member')).toMatchObject({ result: 'applied', changed: false });

		const removed = await identities.syncIdentityProvider(
			event(target, {
				eventId: `evt_${randomUUID().replaceAll('-', '')}`,
				sourceVersion: 4,
				eventType: 'membership.removed',
				organizationId: target.organizationId
			}),
			context()
		);
		expect(removed).toMatchObject({ result: 'applied', changed: true });
		expect(
			await organizations.membershipRole(target.clerkUserId, target.organizationId)
		).toBeUndefined();
		const revoked = await database.query<{
			family_revoked_at: Date | null;
			access_revoked_at: Date | null;
		}>(
			`SELECT family.revoked_at AS family_revoked_at,
			        access_token.revoked_at AS access_revoked_at
			 FROM device_refresh_families family
			 JOIN device_access_tokens access_token ON access_token.family_id = family.id
			 WHERE family.id = $1`,
			[familyId]
		);
		expect(revoked.rows[0]?.family_revoked_at).toBeInstanceOf(Date);
		expect(revoked.rows[0]?.access_revoked_at).toBeInstanceOf(Date);
	});

	it('fails typed on unknown targets and commits denial audits without receipts', async () => {
		const target = await seedTenant('sync-unknown');
		const missingUserEvent = {
			provider: 'clerk' as const,
			eventId: `evt_${randomUUID().replaceAll('-', '')}`,
			sourceVersion: 1,
			eventType: 'user.disabled' as const,
			clerkUserId: `missing_${randomUUID().replaceAll('-', '')}`
		};
		await expect(
			identities.syncIdentityProvider(missingUserEvent, context())
		).rejects.toBeInstanceOf(IdentityProviderSyncTargetNotFound);

		const missingOrganizationEvent = event(target, {
			eventId: `evt_${randomUUID().replaceAll('-', '')}`,
			sourceVersion: 1,
			eventType: 'membership.removed',
			organizationId: randomUUID()
		});
		await expect(
			identities.syncIdentityProvider(missingOrganizationEvent, context())
		).rejects.toBeInstanceOf(IdentityProviderSyncTargetNotFound);

		const evidence = await database.query<{ reason_code: string }>(
			`SELECT reason_code FROM audit_events
			 WHERE action = 'identity.provider.sync' AND resource_id = ANY($1::text[])
			 ORDER BY id`,
			[[missingUserEvent.eventId, missingOrganizationEvent.eventId]]
		);
		expect(evidence.rows).toEqual([
			{ reason_code: 'target_user_not_found' },
			{ reason_code: 'target_organization_not_found' }
		]);
		const receipts = await database.query<{ count: string }>(
			`SELECT count(*)::text FROM identity_provider_sync_receipts
			 WHERE event_id = ANY($1::text[])`,
			[[missingUserEvent.eventId, missingOrganizationEvent.eventId]]
		);
		expect(receipts.rows[0]?.count).toBe('0');
	});

	it('rechecks and locks actor authority transactionally when removal wins the race', async () => {
		const racingOperator = await seedTenant('sync-race-operator');
		const target = await seedTenant('sync-race-target');
		await database.query('INSERT INTO fleet_operator_organizations (organization_id) VALUES ($1)', [
			racingOperator.organizationId
		]);
		const racingEvent = event(target, {
			eventId: `evt_${randomUUID().replaceAll('-', '')}`,
			sourceVersion: 1,
			eventType: 'user.disabled'
		});

		const pool = new Pool({ connectionString: databaseUrl! });
		const remover = await pool.connect();
		try {
			await remover.query('BEGIN');
			await remover.query(
				'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
				[racingOperator.organizationId, racingOperator.userId]
			);
			let settled = false;
			const sync = identities
				.syncIdentityProvider(racingEvent, context(racingOperator))
				.finally(() => {
					settled = true;
				});
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(settled).toBe(false);
			await remover.query('COMMIT');
			await expect(sync).rejects.toBeInstanceOf(IdentityLifecycleAuthorizationDenied);
		} catch (error) {
			await remover.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			remover.release();
			await pool.end();
		}

		const state = await database.query<{ disabled_at: Date | null }>(
			'SELECT disabled_at FROM users WHERE id = $1',
			[target.userId]
		);
		expect(state.rows[0]?.disabled_at).toBeNull();
		const evidence = await database.query<{ reason_code: string; outcome: string }>(
			`SELECT reason_code, outcome FROM audit_events
			 WHERE action = 'identity.provider.sync' AND resource_id = $1
			 ORDER BY id DESC LIMIT 1`,
			[racingEvent.eventId]
		);
		expect(evidence.rows[0]).toEqual({
			reason_code: 'operator_authorization_changed',
			outcome: 'denied'
		});
		const receipt = await database.query<{ count: string }>(
			'SELECT count(*)::text FROM identity_provider_sync_receipts WHERE event_id = $1',
			[racingEvent.eventId]
		);
		expect(receipt.rows[0]?.count).toBe('0');
	});
});
