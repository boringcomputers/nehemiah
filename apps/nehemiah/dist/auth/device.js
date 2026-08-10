import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { auditUserAgentFingerprint } from '../audit/audit.js';
import { apiKeyScopes } from './api-key.js';
const DEVICE_LIFETIME_MS = 10 * 60 * 1_000;
const ACCESS_LIFETIME_MS = 15 * 60 * 1_000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MINIMUM_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const MAXIMUM_REFRESH_GENERATION = 4095;
const INITIAL_POLL_SECONDS = 5;
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ZERO_DIGEST = Buffer.alloc(32);
const DEVICE_RETENTION_CAPACITY_CONSTRAINTS = new Set([
    'device_retention_authorization_capacity',
    'device_retention_family_capacity',
    'device_retention_refresh_capacity',
    'device_retention_access_capacity'
]);
export class DeviceAuthorizationError extends Error {
    code;
    status;
    retryAfterSeconds;
    constructor(code, message, status = 400, retryAfterSeconds) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
const throwDeviceRetentionCapacity = (error) => {
    if (typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === '23514' &&
        DEVICE_RETENTION_CAPACITY_CONSTRAINTS.has(String(Reflect.get(error, 'constraint')))) {
        throw new DeviceAuthorizationError('rate_limited', 'Device login capacity is temporarily exhausted.', 429, 60);
    }
    throw error;
};
const digest = (value) => createHash('sha256').update(value).digest();
const equalDigest = (expected, raw) => timingSafeEqual(expected?.byteLength === 32 ? expected : ZERO_DIGEST, digest(raw)) &&
    expected !== undefined;
const normalizeUserCode = (value) => {
    const normalized = value.toUpperCase().replace(/[-\s]/g, '');
    return normalized.length === 8 &&
        [...normalized].every((character) => USER_CODE_ALPHABET.includes(character))
        ? normalized
        : undefined;
};
const formatUserCode = (normalized) => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
const userCode = () => {
    let output = '';
    while (output.length < 8) {
        for (const byte of randomBytes(16)) {
            // Rejection sampling avoids modulo bias for the 32-character alphabet.
            if (byte >= 224)
                continue;
            output += USER_CODE_ALPHABET[byte & 31];
            if (output.length === 8)
                break;
        }
    }
    return output;
};
const opaqueToken = (kind, id) => `bc_${kind}_${id}_${randomBytes(32).toString('base64url')}`;
const tokenId = (raw, kind) => {
    const match = new RegExp(`^bc_${kind}_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$`, 'i').exec(raw);
    return match?.[1];
};
const validScopes = (scopes) => scopes.length > 0 &&
    scopes.length <= apiKeyScopes.length &&
    scopes.every((scope) => typeof scope === 'string' && apiKeyScopes.includes(scope));
const uniqueScopes = (scopes) => [...new Set(scopes)];
const rolePermits = (role, scope) => {
    if (role === 'owner' || role === 'admin')
        return true;
    if (role === 'billing')
        return scope === 'billing:read';
    return (scope === 'machines:read' ||
        scope === 'machines:write' ||
        scope === 'templates:read' ||
        scope === 'volumes:read' ||
        scope === 'volumes:write');
};
const identityPermits = (row) => row.user_disabled_at === null &&
    row.organization_disabled_at === null &&
    row.membership_role !== null &&
    row.scopes.every((scope) => rolePermits(row.membership_role, scope));
const audit = async (client, input) => {
    await client.query(`INSERT INTO audit_events
		 (event_key, organization_id, project_id, actor_type, actor_id, action,
		  outcome, reason_code, resource_type, resource_id, request_id, user_agent, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
		         'device_authorization', $9, $10, $11, $12)`, [
        `device-auth:${randomUUID()}`,
        input.organizationId ?? null,
        input.projectId ?? null,
        input.actorType,
        input.actorId?.slice(0, 256) ?? null,
        input.action,
        input.outcome,
        input.reasonCode ?? null,
        input.resourceId,
        input.requestId?.slice(0, 128) ?? null,
        auditUserAgentFingerprint(input.userAgent),
        input.metadata ?? {}
    ]);
};
const revokeFamilyForIdentity = async (client, row, now, context) => {
    const revoked = await client.query(`UPDATE device_refresh_families
		 SET revoked_at = COALESCE(revoked_at, $2)
		 WHERE id = $1 AND revoked_at IS NULL
		 RETURNING id`, [row.family_id, now]);
    await client.query('UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [row.family_id, now]);
    await client.query(`UPDATE machine_gateway_grants
		 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
		 WHERE issuer_type = 'device_family' AND issuer_id = $1
		   AND organization_id = $2 AND revoked_at IS NULL`, [row.family_id, row.organization_id]);
    if (revoked.rowCount) {
        await audit(client, {
            organizationId: row.organization_id,
            projectId: row.project_id,
            actorType: 'system',
            actorId: 'identity-lifecycle',
            action: 'device_authorization.identity_invalidated',
            outcome: 'denied',
            reasonCode: 'identity_inactive',
            resourceId: row.family_id,
            requestId: context.requestId,
            userAgent: context.userAgent
        });
    }
};
const rateLimit = async (client, kind, keyHash, limit, now, windowSeconds) => {
    const windowMs = windowSeconds * 1_000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const result = await client.query(`INSERT INTO device_authorization_rate_limits
		 (kind, key_hash, window_started_at, attempts)
		 VALUES ($1, $2, $3, 1)
		 ON CONFLICT (kind, key_hash, window_started_at)
		 DO UPDATE SET attempts = device_authorization_rate_limits.attempts + 1
		 RETURNING attempts`, [kind, keyHash, windowStart]);
    if ((result.rows[0]?.attempts ?? limit + 1) > limit) {
        return Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1_000));
    }
    return undefined;
};
const cleanupRateLimits = async (client, now) => {
    await client.query(`DELETE FROM device_authorization_rate_limits
		 WHERE ctid IN (
		   SELECT ctid FROM device_authorization_rate_limits
		   WHERE window_started_at < $1
		   ORDER BY window_started_at
		   LIMIT 256
		 )`, [new Date(now.getTime() - 60 * 60 * 1_000)]);
};
export class DeviceAuthorizationService {
    database;
    now;
    #verificationUrl;
    #lookupKey;
    constructor(database, verificationUrl, lookupPepper, now = () => new Date()) {
        this.database = database;
        this.now = now;
        const parsed = new URL(verificationUrl);
        parsed.search = '';
        parsed.hash = '';
        this.#verificationUrl = parsed.toString();
        this.#lookupKey = Buffer.from(lookupPepper, 'base64');
        if (this.#lookupKey.byteLength !== 32) {
            throw new Error('device-code lookup pepper must decode to 32 bytes');
        }
    }
    #lookupDigest(value) {
        return createHmac('sha256', this.#lookupKey).update(value).digest();
    }
    async #consumeIssueRateLimits(source, now) {
        const retryAfter = await this.database.transaction(async (client) => {
            await cleanupRateLimits(client, now);
            const global = await rateLimit(client, 'issue_global', this.#lookupDigest('global'), 300, now, 60);
            const perSource = await rateLimit(client, 'issue_source', this.#lookupDigest(source || 'unknown'), 10, now, 60);
            return Math.max(global ?? 0, perSource ?? 0) || undefined;
        });
        if (retryAfter !== undefined) {
            throw new DeviceAuthorizationError('rate_limited', 'Too many device authorization attempts.', 429, retryAfter);
        }
    }
    async #consumeActorRateLimit(actorId, now) {
        const retryAfter = await this.database.transaction(async (client) => {
            await cleanupRateLimits(client, now);
            return rateLimit(client, 'approve_actor', this.#lookupDigest(actorId), 30, now, 300);
        });
        if (retryAfter !== undefined) {
            throw new DeviceAuthorizationError('rate_limited', 'Too many device authorization attempts.', 429, retryAfter);
        }
    }
    async issue(input) {
        const now = this.now();
        await this.#consumeIssueRateLimits(input.source, now);
        if (input.clientId !== 'nehemiah-cli') {
            throw new DeviceAuthorizationError('invalid_client', 'The device client is not allowed.');
        }
        if (!validScopes(input.scopes)) {
            throw new DeviceAuthorizationError('invalid_scope', 'At least one valid scope is required.');
        }
        const scopes = uniqueScopes(input.scopes);
        const expiresAt = new Date(now.getTime() + DEVICE_LIFETIME_MS);
        const firstPollAt = new Date(now.getTime() + INITIAL_POLL_SECONDS * 1_000);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const id = randomUUID();
            const deviceCode = opaqueToken('device', id);
            const normalizedCode = userCode();
            try {
                await this.database.transaction(async (client) => {
                    await client.query(`INSERT INTO device_authorizations
						 (id, device_token_hash, user_code_hash, client_id, requested_scopes,
						  poll_interval_seconds, next_poll_at, created_at, expires_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
                        id,
                        digest(deviceCode),
                        this.#lookupDigest(normalizedCode),
                        input.clientId,
                        scopes,
                        INITIAL_POLL_SECONDS,
                        firstPollAt,
                        now,
                        expiresAt
                    ]);
                    await audit(client, {
                        actorType: 'system',
                        action: 'device_authorization.requested',
                        outcome: 'requested',
                        resourceId: id,
                        requestId: input.requestId,
                        userAgent: input.userAgent,
                        metadata: { client_id: input.clientId, scopes }
                    });
                });
                const code = formatUserCode(normalizedCode);
                const complete = new URL(this.#verificationUrl);
                complete.searchParams.set('user_code', code);
                return {
                    device_code: deviceCode,
                    user_code: code,
                    verification_uri: this.#verificationUrl,
                    verification_uri_complete: complete.toString(),
                    expires_in: DEVICE_LIFETIME_MS / 1_000,
                    interval: INITIAL_POLL_SECONDS,
                    scopes
                };
            }
            catch (error) {
                if (typeof error === 'object' &&
                    error !== null &&
                    Reflect.get(error, 'code') === '23505' &&
                    attempt < 4) {
                    continue;
                }
                throwDeviceRetentionCapacity(error);
            }
        }
        throw new Error('could not allocate a unique device authorization code');
    }
    async inspect(input) {
        const now = this.now();
        await this.#consumeActorRateLimit(input.actorId, now);
        const code = normalizeUserCode(input.userCode);
        if (!code)
            throw new DeviceAuthorizationError('invalid_request', 'The user code is invalid.');
        return this.database.transaction(async (client) => {
            const result = await client.query(`SELECT client_id, requested_scopes, expires_at, status
				 FROM device_authorizations WHERE user_code_hash = $1`, [this.#lookupDigest(code)]);
            const row = result.rows[0];
            if (!row || row.expires_at <= now) {
                throw new DeviceAuthorizationError('expired_token', 'The device code is invalid or expired.', 404);
            }
            if (row.status !== 'pending') {
                throw new DeviceAuthorizationError('invalid_grant', 'The device authorization has already been decided.', 409);
            }
            return {
                client_id: row.client_id,
                scopes: row.requested_scopes,
                expires_at: row.expires_at.toISOString(),
                status: 'pending'
            };
        });
    }
    async authorize(input) {
        const now = this.now();
        await this.#consumeActorRateLimit(input.clerkUserId, now);
        const code = normalizeUserCode(input.userCode);
        if (!code || !['approve', 'deny'].includes(input.decision)) {
            throw new DeviceAuthorizationError('invalid_request', 'The authorization request is invalid.');
        }
        if (input.decision === 'approve' &&
            (!input.projectId ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.projectId))) {
            throw new DeviceAuthorizationError('invalid_request', 'Approval requires a valid project identifier.');
        }
        await this.database.transaction(async (client) => {
            const membership = await client.query(`SELECT u.id, om.role
				 FROM users u
				 JOIN organization_members om ON om.user_id = u.id
				 JOIN organizations organization ON organization.id = om.organization_id
				 WHERE u.clerk_user_id = $1 AND om.organization_id = $2
				   AND u.disabled_at IS NULL AND organization.disabled_at IS NULL`, [input.clerkUserId, input.organizationId]);
            const member = membership.rows[0];
            if (!member) {
                throw new DeviceAuthorizationError('access_denied', 'The selected organization is not available to this user.', 403);
            }
            const pending = await client.query(`SELECT id, requested_scopes, status, expires_at
				 FROM device_authorizations WHERE user_code_hash = $1 FOR UPDATE`, [this.#lookupDigest(code)]);
            const authorization = pending.rows[0];
            if (!authorization || authorization.expires_at <= now) {
                throw new DeviceAuthorizationError('expired_token', 'The device code is invalid or expired.', 404);
            }
            if (authorization.status !== 'pending') {
                throw new DeviceAuthorizationError('invalid_grant', 'The device authorization has already been decided.', 409);
            }
            if (input.decision === 'deny') {
                await client.query(`UPDATE device_authorizations
					 SET status = 'denied', organization_id = $2, approved_by = $3, denied_at = $4
					 WHERE id = $1`, [authorization.id, input.organizationId, member.id, now]);
                await audit(client, {
                    organizationId: input.organizationId,
                    actorType: 'user',
                    actorId: input.clerkUserId,
                    action: 'device_authorization.denied',
                    outcome: 'denied',
                    reasonCode: 'user_denied',
                    resourceId: authorization.id,
                    requestId: input.requestId,
                    userAgent: input.userAgent
                });
                return;
            }
            if (!input.projectId || !input.scopes || !validScopes(input.scopes)) {
                throw new DeviceAuthorizationError('invalid_scope', 'Approval requires a project and at least one valid scope.');
            }
            const scopes = uniqueScopes(input.scopes);
            if (scopes.some((scope) => !authorization.requested_scopes.includes(scope) || !rolePermits(member.role, scope))) {
                throw new DeviceAuthorizationError('invalid_scope', 'One or more scopes were not requested or are not permitted for this user.', 403);
            }
            const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [input.projectId, input.organizationId]);
            if (!project.rowCount) {
                throw new DeviceAuthorizationError('access_denied', 'The selected project is not available to this organization.', 403);
            }
            await client.query(`UPDATE device_authorizations
				 SET status = 'approved', organization_id = $2, project_id = $3,
				     approved_by = $4, approved_scopes = $5, authorized_at = $6
				 WHERE id = $1`, [authorization.id, input.organizationId, input.projectId, member.id, scopes, now]);
            await audit(client, {
                organizationId: input.organizationId,
                projectId: input.projectId,
                actorType: 'user',
                actorId: input.clerkUserId,
                action: 'device_authorization.approved',
                outcome: 'succeeded',
                resourceId: authorization.id,
                requestId: input.requestId,
                userAgent: input.userAgent,
                metadata: { scopes }
            });
        });
    }
    async exchange(deviceCode, context = {}) {
        const id = tokenId(deviceCode, 'device');
        if (!id)
            throw new DeviceAuthorizationError('invalid_grant', 'The device code is invalid.');
        const found = await this.database.query('SELECT device_token_hash FROM device_authorizations WHERE id = $1', [id]);
        if (!equalDigest(found.rows[0]?.device_token_hash, deviceCode)) {
            throw new DeviceAuthorizationError('invalid_grant', 'The device code is invalid.');
        }
        const accessId = randomUUID();
        const refreshId = randomUUID();
        const familyId = randomUUID();
        const accessToken = opaqueToken('access', accessId);
        const refreshToken = opaqueToken('refresh', refreshId);
        const now = this.now();
        const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME_MS);
        const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
        const result = await this.database
            .transaction(async (client) => {
            const locked = await client.query(`SELECT id, device_token_hash, client_id, requested_scopes, approved_scopes,
				        status, organization_id, project_id, approved_by, expires_at,
				        poll_interval_seconds, next_poll_at
				 FROM device_authorizations WHERE id = $1 FOR UPDATE`, [id]);
            const row = locked.rows[0];
            if (!row || row.expires_at <= now)
                return { error: 'expired_token' };
            if (row.status === 'denied')
                return { error: 'access_denied' };
            if (row.status === 'consumed')
                return { error: 'invalid_grant' };
            if (row.status === 'pending') {
                if (row.next_poll_at > now) {
                    const interval = Math.min(60, row.poll_interval_seconds + 5);
                    await client.query(`UPDATE device_authorizations
						 SET poll_interval_seconds = $2, next_poll_at = $3,
						     poll_violations = poll_violations + 1
						 WHERE id = $1`, [id, interval, new Date(now.getTime() + interval * 1_000)]);
                    return { error: 'slow_down', interval };
                }
                await client.query('UPDATE device_authorizations SET next_poll_at = $2 WHERE id = $1', [
                    id,
                    new Date(now.getTime() + row.poll_interval_seconds * 1_000)
                ]);
                return { error: 'authorization_pending', interval: row.poll_interval_seconds };
            }
            if (!row.organization_id || !row.project_id || !row.approved_by || !row.approved_scopes) {
                throw new Error('approved device authorization is missing its tenant binding');
            }
            const currentIdentity = await client.query(`SELECT membership.role
				 FROM users approver
				 JOIN organization_members membership ON membership.user_id = approver.id
				 JOIN organizations organization ON organization.id = membership.organization_id
				 WHERE approver.id = $1 AND membership.organization_id = $2
				   AND approver.disabled_at IS NULL AND organization.disabled_at IS NULL`, [row.approved_by, row.organization_id]);
            const role = currentIdentity.rows[0]?.role;
            if (!role || row.approved_scopes.some((scope) => !rolePermits(role, scope))) {
                await client.query(`UPDATE device_authorizations
					 SET status = 'denied', project_id = NULL, approved_scopes = NULL,
					     authorized_at = NULL, denied_at = $2
					 WHERE id = $1`, [id, now]);
                await audit(client, {
                    organizationId: row.organization_id,
                    actorType: 'system',
                    actorId: 'identity-lifecycle',
                    action: 'device_authorization.identity_invalidated',
                    outcome: 'denied',
                    reasonCode: 'identity_inactive',
                    resourceId: id,
                    requestId: context.requestId,
                    userAgent: context.userAgent
                });
                return { error: 'access_denied' };
            }
            await client.query(`INSERT INTO device_refresh_families
				 (id, device_authorization_id, organization_id, project_id, scopes,
				  created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
                familyId,
                id,
                row.organization_id,
                row.project_id,
                row.approved_scopes,
                now,
                refreshExpiresAt
            ]);
            await client.query(`INSERT INTO device_refresh_tokens
				 (id, family_id, generation, token_hash, created_at, expires_at)
				 VALUES ($1, $2, 0, $3, $4, $5)`, [refreshId, familyId, digest(refreshToken), now, refreshExpiresAt]);
            await client.query(`INSERT INTO device_access_tokens
				 (id, family_id, organization_id, project_id, scopes, token_hash,
				  created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                accessId,
                familyId,
                row.organization_id,
                row.project_id,
                row.approved_scopes,
                digest(accessToken),
                now,
                accessExpiresAt
            ]);
            await client.query("UPDATE device_authorizations SET status = 'consumed', consumed_at = $2 WHERE id = $1", [id, now]);
            await audit(client, {
                organizationId: row.organization_id,
                projectId: row.project_id,
                actorType: 'system',
                action: 'device_authorization.exchanged',
                outcome: 'succeeded',
                resourceId: id,
                requestId: context.requestId,
                userAgent: context.userAgent,
                metadata: { scopes: row.approved_scopes }
            });
            return {
                organizationId: row.organization_id,
                projectId: row.project_id,
                scopes: row.approved_scopes
            };
        })
            .catch(throwDeviceRetentionCapacity);
        if ('error' in result && result.error !== undefined) {
            const message = {
                expired_token: 'The device code has expired.',
                access_denied: 'The device authorization was denied.',
                invalid_grant: 'The device code has already been exchanged.',
                authorization_pending: 'The device authorization is pending.',
                slow_down: 'The device is polling too quickly.'
            }[result.error];
            throw new DeviceAuthorizationError(result.error, message, 400, 'interval' in result ? result.interval : undefined);
        }
        return {
            token_type: 'Bearer',
            access_token: accessToken,
            expires_in: ACCESS_LIFETIME_MS / 1_000,
            refresh_token: refreshToken,
            refresh_expires_in: REFRESH_LIFETIME_MS / 1_000,
            organization_id: result.organizationId,
            project_id: result.projectId,
            scopes: result.scopes
        };
    }
    async refresh(refreshToken, context = {}) {
        const id = tokenId(refreshToken, 'refresh');
        if (!id)
            throw new DeviceAuthorizationError('invalid_grant', 'The refresh token is invalid.');
        const now = this.now();
        const found = await this.database.query(`SELECT refresh_token.token_hash,
			        refresh_token.expires_at AS token_expires_at,
			        family.expires_at AS family_expires_at,
			        family.revoked_at AS family_revoked_at,
			        family.reuse_detected_at
			 FROM device_refresh_tokens refresh_token
			 JOIN device_refresh_families family ON family.id = refresh_token.family_id
			 WHERE refresh_token.id = $1`, [id]);
        const foundRow = found.rows[0];
        if (!equalDigest(foundRow?.token_hash, refreshToken)) {
            throw new DeviceAuthorizationError('invalid_grant', 'The refresh token is invalid.');
        }
        if (foundRow?.reuse_detected_at) {
            throw new DeviceAuthorizationError('refresh_reuse_detected', 'Refresh-token reuse was detected; this login has been revoked.');
        }
        if (!foundRow ||
            foundRow.family_revoked_at ||
            foundRow.token_expires_at <= now ||
            foundRow.family_expires_at <= now) {
            throw new DeviceAuthorizationError('invalid_grant', 'The refresh token is invalid.');
        }
        const nextRefreshId = randomUUID();
        const accessId = randomUUID();
        const nextRefreshToken = opaqueToken('refresh', nextRefreshId);
        const accessToken = opaqueToken('access', accessId);
        const outcome = await this.database
            .transaction(async (client) => {
            // Whole-family cleanup and every operation that can mutate a family
            // acquire the family before any child token. Terminal requests are
            // filtered above, preventing child->family cleanup deadlocks.
            const familyLock = await client.query(`SELECT family.id AS family_id
					 FROM device_refresh_tokens refresh_token
					 JOIN device_refresh_families family ON family.id = refresh_token.family_id
					 WHERE refresh_token.id = $1
					   AND refresh_token.expires_at > $2
					   AND family.expires_at > $2
					   AND family.revoked_at IS NULL
					 FOR UPDATE OF family`, [id, now]);
            if (!familyLock.rows[0])
                return { error: 'invalid_grant' };
            const locked = await client.query(`SELECT rt.id, rt.token_hash, rt.family_id, rt.generation, rt.used_at,
				        rt.created_at AS token_created_at,
				        rt.expires_at AS token_expires_at, rf.expires_at AS family_expires_at,
				        rf.revoked_at, rf.reuse_detected_at,
				        rf.organization_id, rf.project_id, rf.scopes,
				        device_auth.approved_by, membership.role AS membership_role,
				        approver.disabled_at AS user_disabled_at,
				        organization.disabled_at AS organization_disabled_at
				 FROM device_refresh_tokens rt
				 JOIN device_refresh_families rf ON rf.id = rt.family_id
				 JOIN device_authorizations device_auth
				   ON device_auth.id = rf.device_authorization_id
				 JOIN users approver ON approver.id = device_auth.approved_by
				 JOIN organizations organization ON organization.id = rf.organization_id
				 LEFT JOIN organization_members membership
				   ON membership.user_id = device_auth.approved_by
				  AND membership.organization_id = rf.organization_id
				 WHERE rt.id = $1 AND rf.id = $2 FOR UPDATE OF rt`, [id, familyLock.rows[0].family_id]);
            const row = locked.rows[0];
            if (!row)
                return { error: 'invalid_grant' };
            if (row.used_at) {
                await client.query(`UPDATE device_refresh_families
					 SET revoked_at = COALESCE(revoked_at, $2), reuse_detected_at = COALESCE(reuse_detected_at, $2)
					 WHERE id = $1`, [row.family_id, now]);
                await client.query('UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [row.family_id, now]);
                await client.query(`UPDATE machine_gateway_grants
					 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
					 WHERE issuer_type = 'device_family' AND issuer_id = $1
					   AND organization_id = $2 AND expires_at > statement_timestamp()`, [row.family_id, row.organization_id]);
                if (!row.reuse_detected_at) {
                    await audit(client, {
                        organizationId: row.organization_id,
                        projectId: row.project_id,
                        actorType: 'api_key',
                        actorId: row.family_id,
                        action: 'device_authorization.refresh_reuse_detected',
                        outcome: 'denied',
                        reasonCode: 'refresh_reuse_detected',
                        resourceId: row.family_id,
                        requestId: context.requestId,
                        userAgent: context.userAgent
                    });
                }
                return { error: 'refresh_reuse_detected' };
            }
            if (row.revoked_at || row.token_expires_at <= now || row.family_expires_at <= now) {
                return { error: 'invalid_grant' };
            }
            if (!identityPermits(row)) {
                await revokeFamilyForIdentity(client, row, now, context);
                return { error: 'invalid_grant' };
            }
            const nextRefreshAt = new Date(row.token_created_at.getTime() + MINIMUM_REFRESH_INTERVAL_MS);
            if (now < nextRefreshAt) {
                return {
                    error: 'slow_down',
                    retryAfterSeconds: Math.max(1, Math.ceil((nextRefreshAt.getTime() - now.getTime()) / 1_000))
                };
            }
            if (row.generation >= MAXIMUM_REFRESH_GENERATION) {
                await client.query('UPDATE device_refresh_families SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [row.family_id, now]);
                await client.query('UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [row.family_id, now]);
                await client.query(`UPDATE machine_gateway_grants
					 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
					 WHERE issuer_type = 'device_family' AND issuer_id = $1
					   AND organization_id = $2 AND expires_at > statement_timestamp()`, [row.family_id, row.organization_id]);
                await audit(client, {
                    organizationId: row.organization_id,
                    projectId: row.project_id,
                    actorType: 'api_key',
                    actorId: row.family_id,
                    action: 'device_authorization.refresh_generation_exhausted',
                    outcome: 'denied',
                    reasonCode: 'refresh_generation_exhausted',
                    resourceId: row.family_id,
                    requestId: context.requestId,
                    userAgent: context.userAgent,
                    metadata: { maximum_generation: MAXIMUM_REFRESH_GENERATION }
                });
                return { error: 'expired_token' };
            }
            const accessExpiresAt = new Date(Math.min(now.getTime() + ACCESS_LIFETIME_MS, row.family_expires_at.getTime()));
            await client.query(`INSERT INTO device_refresh_tokens
				 (id, family_id, generation, token_hash, created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6)`, [
                nextRefreshId,
                row.family_id,
                row.generation + 1,
                digest(nextRefreshToken),
                now,
                row.family_expires_at
            ]);
            await client.query('UPDATE device_refresh_tokens SET used_at = $2, replaced_by = $3 WHERE id = $1', [id, now, nextRefreshId]);
            await client.query(`INSERT INTO device_access_tokens
				 (id, family_id, organization_id, project_id, scopes, token_hash,
				  created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                accessId,
                row.family_id,
                row.organization_id,
                row.project_id,
                row.scopes,
                digest(accessToken),
                now,
                accessExpiresAt
            ]);
            await audit(client, {
                organizationId: row.organization_id,
                projectId: row.project_id,
                actorType: 'api_key',
                actorId: row.family_id,
                action: 'device_authorization.refreshed',
                outcome: 'succeeded',
                resourceId: row.family_id,
                requestId: context.requestId,
                userAgent: context.userAgent,
                metadata: { generation: row.generation + 1 }
            });
            return {
                organizationId: row.organization_id,
                projectId: row.project_id,
                scopes: row.scopes,
                refreshExpiresIn: Math.max(1, Math.floor((row.family_expires_at.getTime() - now.getTime()) / 1_000)),
                accessExpiresIn: Math.max(1, Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1_000))
            };
        })
            .catch(throwDeviceRetentionCapacity);
        if ('error' in outcome && outcome.error !== undefined) {
            if (outcome.error === 'slow_down') {
                throw new DeviceAuthorizationError('slow_down', 'The refresh credential was rotated too recently.', 429, outcome.retryAfterSeconds);
            }
            throw new DeviceAuthorizationError(outcome.error, outcome.error === 'refresh_reuse_detected'
                ? 'Refresh-token reuse was detected; this login has been revoked.'
                : 'The refresh token is invalid, expired, or requires reauthentication.');
        }
        return {
            token_type: 'Bearer',
            access_token: accessToken,
            expires_in: outcome.accessExpiresIn,
            refresh_token: nextRefreshToken,
            refresh_expires_in: outcome.refreshExpiresIn,
            organization_id: outcome.organizationId,
            project_id: outcome.projectId,
            scopes: outcome.scopes
        };
    }
    async revoke(refreshToken, context = {}) {
        const id = tokenId(refreshToken, 'refresh');
        if (!id)
            return false;
        const now = this.now();
        const found = await this.database.query(`SELECT refresh_token.token_hash
			 FROM device_refresh_tokens refresh_token
			 JOIN device_refresh_families family ON family.id = refresh_token.family_id
			 WHERE refresh_token.id = $1
			   AND refresh_token.expires_at > $2
			   AND family.expires_at > $2
			   AND family.revoked_at IS NULL`, [id, now]);
        if (!equalDigest(found.rows[0]?.token_hash, refreshToken))
            return false;
        return this.database.transaction(async (client) => {
            const locked = await client.query(`SELECT rt.id, rt.token_hash, rt.family_id, rt.generation, rt.used_at,
				        rt.expires_at AS token_expires_at, rf.expires_at AS family_expires_at,
				        rf.revoked_at, rf.reuse_detected_at,
				        rf.organization_id, rf.project_id, rf.scopes
				 FROM device_refresh_tokens rt
				 JOIN device_refresh_families rf ON rf.id = rt.family_id
				 WHERE rt.id = $1
				   AND rt.expires_at > $2
				   AND rf.expires_at > $2
				   AND rf.revoked_at IS NULL
				 FOR UPDATE OF rf`, [id, now]);
            const row = locked.rows[0];
            if (!row || row.revoked_at)
                return false;
            await client.query('UPDATE device_refresh_families SET revoked_at = $2 WHERE id = $1', [
                row.family_id,
                now
            ]);
            await client.query('UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [row.family_id, now]);
            await client.query(`UPDATE machine_gateway_grants
				 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
				 WHERE issuer_type = 'device_family' AND issuer_id = $1
				   AND organization_id = $2 AND expires_at > statement_timestamp()`, [row.family_id, row.organization_id]);
            await audit(client, {
                organizationId: row.organization_id,
                projectId: row.project_id,
                actorType: 'api_key',
                actorId: row.family_id,
                action: 'device_authorization.revoked',
                outcome: 'succeeded',
                resourceId: row.family_id,
                requestId: context.requestId,
                userAgent: context.userAgent
            });
            return true;
        });
    }
    async authenticateAccess(raw, context = {}) {
        const id = tokenId(raw, 'access');
        if (!id)
            return undefined;
        const now = this.now();
        const found = await this.database.query(`SELECT access_token.token_hash
			 FROM device_access_tokens access_token
			 JOIN device_refresh_families family ON family.id = access_token.family_id
			 WHERE access_token.id = $1
			   AND access_token.expires_at > $2
			   AND access_token.revoked_at IS NULL
			   AND family.expires_at > $2
			   AND family.revoked_at IS NULL`, [id, now]);
        if (!equalDigest(found.rows[0]?.token_hash, raw))
            return undefined;
        return this.database.transaction(async (client) => {
            const familyLock = await client.query(`SELECT family.id AS family_id
				 FROM device_access_tokens access_token
				 JOIN device_refresh_families family ON family.id = access_token.family_id
				 WHERE access_token.id = $1
				   AND access_token.expires_at > $2
				   AND access_token.revoked_at IS NULL
				   AND family.expires_at > $2
				   AND family.revoked_at IS NULL
				 FOR UPDATE OF family`, [id, now]);
            if (!familyLock.rows[0])
                return undefined;
            const result = await client.query(`SELECT access_token.id, access_token.token_hash, access_token.family_id,
				        access_token.organization_id, access_token.project_id, access_token.scopes,
				        access_token.expires_at, access_token.revoked_at,
				        family.revoked_at AS family_revoked_at,
				        family.expires_at AS family_expires_at,
				        device_auth.approved_by, membership.role AS membership_role,
				        approver.disabled_at AS user_disabled_at,
				        organization.disabled_at AS organization_disabled_at
				 FROM device_access_tokens access_token
				 JOIN device_refresh_families family ON family.id = access_token.family_id
				 JOIN device_authorizations device_auth
				   ON device_auth.id = family.device_authorization_id
				 JOIN users approver ON approver.id = device_auth.approved_by
				 JOIN organizations organization ON organization.id = family.organization_id
				 LEFT JOIN organization_members membership
				   ON membership.user_id = device_auth.approved_by
				  AND membership.organization_id = family.organization_id
				 WHERE access_token.id = $1 AND family.id = $2 FOR UPDATE OF access_token`, [id, familyLock.rows[0].family_id]);
            const row = result.rows[0];
            if (!row ||
                !equalDigest(row.token_hash, raw) ||
                row.revoked_at ||
                row.family_revoked_at ||
                row.expires_at <= now ||
                row.family_expires_at <= now) {
                return undefined;
            }
            if (!identityPermits(row)) {
                await revokeFamilyForIdentity(client, row, now, context);
                return undefined;
            }
            await client.query('UPDATE device_access_tokens SET last_used_at = $2 WHERE id = $1', [
                id,
                now
            ]);
            return {
                kind: 'api_key',
                apiKeyId: `device-access:${id}`,
                deviceFamilyId: row.family_id,
                organizationId: row.organization_id,
                projectId: row.project_id,
                scopes: new Set(row.scopes)
            };
        });
    }
}
//# sourceMappingURL=device.js.map