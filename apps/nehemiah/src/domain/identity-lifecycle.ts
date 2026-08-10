import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { auditUserAgentFingerprint } from '../audit/audit.js';
import { Database } from '../db/client.js';

export type IdentityLifecycleActorType = 'user' | 'system';

export interface IdentityLifecycleContext {
	readonly actorType: IdentityLifecycleActorType;
	readonly actorId: string;
	/** The operator organization, when the actor is a dashboard user. */
	readonly actorOrganizationId?: string;
	readonly reason: string;
	readonly requestId?: string;
	readonly userAgent?: string;
}

export interface IdentityLifecycleState {
	readonly id: string;
	readonly disabledAt?: Date;
	readonly changed: boolean;
}

export type IdentityProviderSyncEventType =
	'user.disabled' | 'user.deleted' | 'membership.upserted' | 'membership.removed';

export type IdentityProviderMembershipRole = 'owner' | 'admin' | 'member' | 'billing';

export interface IdentityProviderSyncInput {
	readonly provider: 'clerk';
	readonly eventId: string;
	readonly sourceVersion: number;
	readonly eventType: IdentityProviderSyncEventType;
	readonly clerkUserId: string;
	readonly organizationId?: string;
	readonly role?: IdentityProviderMembershipRole;
}

export interface IdentityProviderSyncResult {
	readonly provider: 'clerk';
	readonly eventId: string;
	readonly sourceVersion: number;
	readonly result: 'applied' | 'stale' | 'replayed';
	readonly changed: boolean;
	readonly userId: string;
	readonly organizationId?: string;
}

export class InvalidIdentityLifecycleRequest extends Error {
	readonly code = 'invalid_identity_lifecycle_request';
}

export class IdentityLifecycleAuthorizationDenied extends Error {
	readonly code = 'fleet_operator_required';

	constructor() {
		super('current fleet-operator owner or administrator authorization is required');
	}
}

export class IdentityProviderSyncTargetNotFound extends Error {
	readonly code = 'identity_provider_target_not_found';

	constructor() {
		super('The mapped local identity target was not found.');
	}
}

export class IdentityProviderSyncConflict extends Error {
	readonly code = 'identity_provider_sync_conflict';

	constructor() {
		super('The provider event conflicts with previously accepted source ordering.');
	}
}

const bounded = (value: string | undefined, maximum: number): string | null =>
	value ? value.slice(0, maximum) : null;

const validateContext = (context: IdentityLifecycleContext): void => {
	if (!context.actorId.trim() || context.actorId.length > 256) {
		throw new InvalidIdentityLifecycleRequest('actor identity must contain 1 to 256 characters');
	}
	if (!context.reason.trim() || context.reason.length > 512) {
		throw new InvalidIdentityLifecycleRequest('reason must contain 1 to 512 characters');
	}
	if (
		context.actorType === 'user' &&
		(!context.actorOrganizationId ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				context.actorOrganizationId
			))
	) {
		throw new InvalidIdentityLifecycleRequest(
			'user lifecycle actors require a valid operator organization'
		);
	}
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeProviderToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const validateSyncInput = (input: IdentityProviderSyncInput): void => {
	if (input.provider !== 'clerk') {
		throw new InvalidIdentityLifecycleRequest('The identity provider is not supported.');
	}
	if (!safeProviderToken.test(input.eventId) || input.eventId.length > 128) {
		throw new InvalidIdentityLifecycleRequest('event_id must be a safe 1 to 128 character token');
	}
	if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1) {
		throw new InvalidIdentityLifecycleRequest('source_version must be a positive safe integer');
	}
	if (!safeProviderToken.test(input.clerkUserId)) {
		throw new InvalidIdentityLifecycleRequest(
			'clerk_user_id must be a safe 1 to 256 character subject'
		);
	}
	if (
		!['user.disabled', 'user.deleted', 'membership.upserted', 'membership.removed'].includes(
			input.eventType
		)
	) {
		throw new InvalidIdentityLifecycleRequest('event_type is not supported');
	}
	const membershipEvent = input.eventType.startsWith('membership.');
	if (membershipEvent !== Boolean(input.organizationId)) {
		throw new InvalidIdentityLifecycleRequest(
			'membership events require exactly one local organization target'
		);
	}
	if (input.organizationId && !uuid.test(input.organizationId)) {
		throw new InvalidIdentityLifecycleRequest('organization_id must be a valid local UUID');
	}
	if (input.eventType === 'membership.upserted') {
		if (!input.role || !['owner', 'admin', 'member', 'billing'].includes(input.role)) {
			throw new InvalidIdentityLifecycleRequest('membership.upserted requires a supported role');
		}
	} else if (input.role !== undefined) {
		throw new InvalidIdentityLifecycleRequest('role is valid only for membership.upserted');
	}
};

/**
 * System actors are explicit trusted callers. User actors are re-authorized
 * inside the mutation transaction and every authority row is held with SHARE,
 * which conflicts with disable, role-change, membership/provider removal, and
 * deletion until the lifecycle mutation commits.
 */
const lockLifecycleActor = async (
	client: PoolClient,
	context: IdentityLifecycleContext
): Promise<boolean> => {
	if (context.actorType === 'system') return true;
	const result = await client.query(
		`SELECT actor.id
		 FROM fleet_operator_organizations provider_authorization
		 JOIN organizations operator_organization
		   ON operator_organization.id = provider_authorization.organization_id
		 JOIN organization_members membership
		   ON membership.organization_id = operator_organization.id
		 JOIN users actor ON actor.id = membership.user_id
		 WHERE provider_authorization.organization_id = $1
		   AND actor.clerk_user_id = $2
		   AND operator_organization.disabled_at IS NULL
		   AND actor.disabled_at IS NULL
		   AND membership.role IN ('owner', 'admin')
		 FOR SHARE OF provider_authorization, operator_organization, membership, actor`,
		[context.actorOrganizationId, context.actorId]
	);
	return Boolean(result.rowCount);
};

const audit = async (
	client: PoolClient,
	input: {
		readonly context: IdentityLifecycleContext;
		readonly action: string;
		readonly resourceType:
			'user' | 'organization' | 'identity_provider_event' | 'organization_membership';
		readonly resourceId: string;
		readonly organizationId?: string;
		readonly outcome: 'succeeded' | 'denied';
		readonly reasonCode?: string;
		readonly changed?: boolean;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly retainReason?: boolean;
	}
): Promise<void> => {
	await client.query(
		`INSERT INTO audit_events
		 (event_key, operation_id, organization_id, actor_type, actor_id, action,
		  outcome, reason_code, resource_type, resource_id, request_id, user_agent,
		  metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		[
			`identity-lifecycle:${randomUUID()}`,
			randomUUID(),
			input.organizationId ?? input.context.actorOrganizationId ?? null,
			input.context.actorType,
			input.context.actorId.slice(0, 256),
			input.action,
			input.outcome,
			input.reasonCode ?? null,
			input.resourceType,
			input.resourceId.slice(0, 256),
			bounded(input.context.requestId, 128),
			auditUserAgentFingerprint(input.context.userAgent),
			{
				...(input.retainReason === false ? {} : { reason: input.context.reason.trim() }),
				...(input.changed === undefined ? {} : { changed: input.changed }),
				...(input.metadata ?? {}),
				...(input.context.actorOrganizationId
					? { actor_organization_id: input.context.actorOrganizationId }
					: {})
			}
		]
	);
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const syncPayloadHash = (
	input: IdentityProviderSyncInput,
	context: IdentityLifecycleContext
): string =>
	sha256(
		JSON.stringify([
			input.provider,
			input.eventId,
			input.sourceVersion,
			input.eventType,
			input.clerkUserId,
			input.organizationId ?? null,
			input.role ?? null,
			context.reason.trim()
		])
	);

const syncStreamHash = (input: IdentityProviderSyncInput, userId: string): string =>
	sha256(
		input.organizationId
			? `${input.provider}\0membership\0${userId}\0${input.organizationId.toLowerCase()}`
			: `${input.provider}\0user\0${userId}`
	);

const syncAuditMetadata = (
	input: IdentityProviderSyncInput,
	payloadSha256: string,
	result?: 'applied' | 'stale' | 'replayed'
): Readonly<Record<string, unknown>> => ({
	provider: input.provider,
	event_type: input.eventType,
	source_version: input.sourceVersion,
	payload_sha256: payloadSha256,
	...(input.role ? { role: input.role } : {}),
	...(result ? { sync_result: result } : {})
});

export class IdentityLifecycleService {
	constructor(private readonly database: Database) {}

	async syncIdentityProvider(
		input: IdentityProviderSyncInput,
		context: IdentityLifecycleContext
	): Promise<IdentityProviderSyncResult> {
		validateContext(context);
		validateSyncInput(input);
		const payloadSha256 = syncPayloadHash(input, context);
		const action = 'identity.provider.sync';
		const resourceType = input.organizationId
			? ('organization_membership' as const)
			: ('identity_provider_event' as const);

		const outcome = await this.database.transaction(async (client) => {
			const record = (
				outcome: 'succeeded' | 'denied',
				options: {
					readonly reasonCode?: string;
					readonly changed?: boolean;
					readonly result?: 'applied' | 'stale' | 'replayed';
					readonly targetOrganizationExists?: boolean;
				} = {}
			) =>
				audit(client, {
					context,
					action,
					resourceType,
					resourceId: input.eventId,
					...(input.organizationId && options.targetOrganizationExists
						? { organizationId: input.organizationId }
						: {}),
					outcome,
					reasonCode: options.reasonCode,
					changed: options.changed,
					metadata: syncAuditMetadata(input, payloadSha256, options.result),
					retainReason: false
				});

			if (context.actorType !== 'user' || !(await lockLifecycleActor(client, context))) {
				await record('denied', { reasonCode: 'operator_authorization_changed' });
				return { error: new IdentityLifecycleAuthorizationDenied() } as const;
			}

			const mappedUser = await client.query<{ id: string }>(
				'SELECT id FROM users WHERE clerk_user_id = $1',
				[input.clerkUserId]
			);
			const userId = mappedUser.rows[0]?.id;
			if (!userId) {
				await record('denied', { reasonCode: 'target_user_not_found' });
				return { error: new IdentityProviderSyncTargetNotFound() } as const;
			}

			let targetOrganizationExists = false;
			if (input.organizationId) {
				const organization = await client.query<{ id: string }>(
					'SELECT id FROM organizations WHERE id = $1',
					[input.organizationId]
				);
				targetOrganizationExists = Boolean(organization.rowCount);
				if (!targetOrganizationExists) {
					await record('denied', { reasonCode: 'target_organization_not_found' });
					return { error: new IdentityProviderSyncTargetNotFound() } as const;
				}
			}

			const streamSha256 = syncStreamHash(input, userId);
			// A global event-ID lock closes cross-stream races on the primary key.
			// Every transaction then takes its stream lock in the same order.
			await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
				`identity-provider-event:${sha256(`${input.provider}\0${input.eventId}`)}`
			]);
			await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
				`identity-provider-stream:${streamSha256}`
			]);

			const lockedUser = await client.query<{ id: string; disabled_at: Date | null }>(
				input.organizationId
					? 'SELECT id, disabled_at FROM users WHERE id = $1 AND clerk_user_id = $2 FOR SHARE'
					: 'SELECT id, disabled_at FROM users WHERE id = $1 AND clerk_user_id = $2 FOR UPDATE',
				[userId, input.clerkUserId]
			);
			if (!lockedUser.rowCount) {
				await record('denied', { reasonCode: 'target_user_changed' });
				return { error: new IdentityProviderSyncTargetNotFound() } as const;
			}
			if (input.organizationId) {
				const lockedOrganization = await client.query(
					'SELECT id FROM organizations WHERE id = $1 FOR SHARE',
					[input.organizationId]
				);
				if (!lockedOrganization.rowCount) {
					await record('denied', { reasonCode: 'target_organization_changed' });
					return { error: new IdentityProviderSyncTargetNotFound() } as const;
				}
			}

			const existingEvent = await client.query<{
				payload_sha256: string;
				source_version: string;
				changed: boolean;
				user_id: string;
				organization_id: string | null;
			}>(
				`SELECT payload_sha256, source_version::text, changed, user_id, organization_id
				 FROM identity_provider_sync_receipts
				 WHERE provider = $1 AND event_id = $2`,
				[input.provider, input.eventId]
			);
			const existing = existingEvent.rows[0];
			if (existing) {
				if (existing.payload_sha256 !== payloadSha256) {
					await record('denied', {
						reasonCode: 'event_id_conflict',
						targetOrganizationExists
					});
					return { error: new IdentityProviderSyncConflict() } as const;
				}
				await record('succeeded', {
					changed: existing.changed,
					result: 'replayed',
					targetOrganizationExists
				});
				return {
					result: {
						provider: input.provider,
						eventId: input.eventId,
						sourceVersion: Number(existing.source_version),
						result: 'replayed' as const,
						changed: existing.changed,
						userId: existing.user_id,
						...(existing.organization_id ? { organizationId: existing.organization_id } : {})
					}
				} as const;
			}

			const sameVersion = await client.query<{ event_id: string }>(
				`SELECT event_id
				 FROM identity_provider_sync_receipts
				 WHERE provider = $1 AND stream_sha256 = $2 AND source_version = $3`,
				[input.provider, streamSha256, input.sourceVersion]
			);
			if (sameVersion.rowCount) {
				await record('denied', {
					reasonCode: 'source_version_conflict',
					targetOrganizationExists
				});
				return { error: new IdentityProviderSyncConflict() } as const;
			}

			const latest = await client.query<{ source_version: string }>(
				`SELECT source_version::text
				 FROM identity_provider_sync_receipts
				 WHERE provider = $1 AND stream_sha256 = $2
				 ORDER BY source_version DESC LIMIT 1`,
				[input.provider, streamSha256]
			);
			if (latest.rows[0] && input.sourceVersion < Number(latest.rows[0].source_version)) {
				await client.query(
					`INSERT INTO identity_provider_sync_receipts
					 (provider, event_id, payload_sha256, stream_sha256, source_version,
					  event_type, user_id, organization_id, role, result, changed)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stale', false)`,
					[
						input.provider,
						input.eventId,
						payloadSha256,
						streamSha256,
						input.sourceVersion,
						input.eventType,
						userId,
						input.organizationId ?? null,
						input.role ?? null
					]
				);
				await record('succeeded', {
					changed: false,
					result: 'stale',
					targetOrganizationExists
				});
				return {
					result: {
						provider: input.provider,
						eventId: input.eventId,
						sourceVersion: input.sourceVersion,
						result: 'stale' as const,
						changed: false,
						userId,
						...(input.organizationId ? { organizationId: input.organizationId } : {})
					}
				} as const;
			}

			let changed = false;
			if (input.eventType === 'user.disabled' || input.eventType === 'user.deleted') {
				changed = lockedUser.rows[0]!.disabled_at === null;
				if (changed) {
					await client.query(
						`UPDATE users
						 SET disabled_at = statement_timestamp(), updated_at = statement_timestamp()
						 WHERE id = $1`,
						[userId]
					);
				}
			} else if (input.eventType === 'membership.upserted') {
				const membership = await client.query<{ role: string }>(
					`SELECT role FROM organization_members
					 WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
					[input.organizationId, userId]
				);
				if (!membership.rows[0]) {
					await client.query(
						`INSERT INTO organization_members (organization_id, user_id, role)
						 VALUES ($1, $2, $3)`,
						[input.organizationId, userId, input.role]
					);
					changed = true;
				} else if (membership.rows[0].role !== input.role) {
					await client.query(
						`UPDATE organization_members SET role = $3
						 WHERE organization_id = $1 AND user_id = $2`,
						[input.organizationId, userId, input.role]
					);
					changed = true;
				}
			} else {
				const removed = await client.query(
					`DELETE FROM organization_members
					 WHERE organization_id = $1 AND user_id = $2`,
					[input.organizationId, userId]
				);
				changed = Boolean(removed.rowCount);
			}

			await client.query(
				`INSERT INTO identity_provider_sync_receipts
				 (provider, event_id, payload_sha256, stream_sha256, source_version,
				  event_type, user_id, organization_id, role, result, changed)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'applied', $10)`,
				[
					input.provider,
					input.eventId,
					payloadSha256,
					streamSha256,
					input.sourceVersion,
					input.eventType,
					userId,
					input.organizationId ?? null,
					input.role ?? null,
					changed
				]
			);
			await record('succeeded', {
				changed,
				result: 'applied',
				targetOrganizationExists
			});
			return {
				result: {
					provider: input.provider,
					eventId: input.eventId,
					sourceVersion: input.sourceVersion,
					result: 'applied' as const,
					changed,
					userId,
					...(input.organizationId ? { organizationId: input.organizationId } : {})
				}
			} as const;
		});

		if ('error' in outcome) throw outcome.error;
		return outcome.result;
	}

	async #setUserDisabled(
		id: string,
		disabled: boolean,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		validateContext(context);
		const outcome = await this.database.transaction(async (client) => {
			const action = disabled ? 'identity.user.disable' : 'identity.user.enable';
			if (!(await lockLifecycleActor(client, context))) {
				await audit(client, {
					context,
					action,
					resourceType: 'user',
					resourceId: id,
					outcome: 'denied',
					reasonCode: 'operator_authorization_changed'
				});
				return { authorizationDenied: true as const };
			}
			const selected = await client.query<{ id: string; disabled_at: Date | null }>(
				'SELECT id, disabled_at FROM users WHERE id = $1 FOR UPDATE',
				[id]
			);
			const current = selected.rows[0];
			if (!current) {
				await audit(client, {
					context,
					action,
					resourceType: 'user',
					resourceId: id,
					outcome: 'denied',
					reasonCode: 'target_not_found'
				});
				return { authorizationDenied: false as const, state: undefined };
			}
			const changed = disabled ? current.disabled_at === null : current.disabled_at !== null;
			const updated = changed
				? await client.query<{ id: string; disabled_at: Date | null }>(
						`UPDATE users
						 SET disabled_at = CASE WHEN $2 THEN statement_timestamp() ELSE NULL END,
						     updated_at = statement_timestamp()
						 WHERE id = $1 RETURNING id, disabled_at`,
						[id, disabled]
					)
				: selected;
			const state = updated.rows[0]!;
			await audit(client, {
				context,
				action,
				resourceType: 'user',
				resourceId: id,
				outcome: 'succeeded',
				changed
			});
			return {
				authorizationDenied: false as const,
				state: { id: state.id, disabledAt: state.disabled_at ?? undefined, changed }
			};
		});
		if (outcome.authorizationDenied) throw new IdentityLifecycleAuthorizationDenied();
		return outcome.state;
	}

	async #setOrganizationDisabled(
		id: string,
		disabled: boolean,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		validateContext(context);
		const outcome = await this.database.transaction(async (client) => {
			const action = disabled ? 'identity.organization.disable' : 'identity.organization.enable';
			if (!(await lockLifecycleActor(client, context))) {
				await audit(client, {
					context,
					action,
					resourceType: 'organization',
					resourceId: id,
					outcome: 'denied',
					reasonCode: 'operator_authorization_changed'
				});
				return { authorizationDenied: true as const };
			}
			const selected = await client.query<{ id: string; disabled_at: Date | null }>(
				'SELECT id, disabled_at FROM organizations WHERE id = $1 FOR UPDATE',
				[id]
			);
			const current = selected.rows[0];
			if (!current) {
				await audit(client, {
					context,
					action,
					resourceType: 'organization',
					resourceId: id,
					outcome: 'denied',
					reasonCode: 'target_not_found'
				});
				return { authorizationDenied: false as const, state: undefined };
			}
			const changed = disabled ? current.disabled_at === null : current.disabled_at !== null;
			const updated = changed
				? await client.query<{ id: string; disabled_at: Date | null }>(
						`UPDATE organizations
						 SET disabled_at = CASE WHEN $2 THEN statement_timestamp() ELSE NULL END,
						     updated_at = statement_timestamp()
						 WHERE id = $1 RETURNING id, disabled_at`,
						[id, disabled]
					)
				: selected;
			const state = updated.rows[0]!;
			await audit(client, {
				context,
				action,
				resourceType: 'organization',
				resourceId: id,
				organizationId: id,
				outcome: 'succeeded',
				changed
			});
			return {
				authorizationDenied: false as const,
				state: { id: state.id, disabledAt: state.disabled_at ?? undefined, changed }
			};
		});
		if (outcome.authorizationDenied) throw new IdentityLifecycleAuthorizationDenied();
		return outcome.state;
	}

	disableUser(
		id: string,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		return this.#setUserDisabled(id, true, context);
	}

	enableUser(
		id: string,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		return this.#setUserDisabled(id, false, context);
	}

	disableOrganization(
		id: string,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		return this.#setOrganizationDisabled(id, true, context);
	}

	enableOrganization(
		id: string,
		context: IdentityLifecycleContext
	): Promise<IdentityLifecycleState | undefined> {
		return this.#setOrganizationDisabled(id, false, context);
	}
}
