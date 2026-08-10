import { randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { auditUserAgentFingerprint } from '../audit/audit.js';
export const apiKeyScopes = [
    'machines:read',
    'machines:write',
    'templates:read',
    'templates:write',
    'volumes:read',
    'volumes:write',
    'billing:read'
];
export class InvalidApiKeyRequest extends Error {
    code = 'invalid_api_key';
}
export class ApiKeyPrefixCollision extends Error {
    code = 'api_key_prefix_collision';
}
export class ApiKeyAllocationUnavailable extends Error {
    code = 'api_key_allocation_unavailable';
}
export class ApiKeyAuthorizationDenied extends Error {
    code = 'api_key_administrator_required';
    constructor() {
        super('a current owner or administrator is required for API-key lifecycle changes');
    }
}
export class ApiKeyVerifierBusy extends Error {
    code = 'api_key_verifier_busy';
    constructor() {
        super('API-key verification capacity is temporarily exhausted.');
    }
}
export class ApiKeyHasherBusy extends Error {
    code = 'api_key_hasher_busy';
    constructor() {
        super('API-key creation capacity is temporarily exhausted.');
    }
}
export class ApiKeyQuotaExceeded extends Error {
    code = 'api_key_quota_exceeded';
    constructor() {
        super('The API-key quota has been reached. Revoke an existing key before creating another.');
    }
}
const isPrefixCollision = (error) => typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === '23505' &&
    Reflect.get(error, 'constraint') === 'api_keys_prefix_key';
const isAllocationQuotaExceeded = (error) => typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === '23514' &&
    typeof Reflect.get(error, 'constraint') === 'string' &&
    Reflect.get(error, 'constraint').startsWith('api_keys_') &&
    Reflect.get(error, 'constraint').endsWith('_quota');
const auditActor = (actorId) => actorId ? 'user' : 'system';
const insertAudit = async (client, input) => {
    await client.query(`INSERT INTO audit_events
		 (event_key, operation_id, organization_id, project_id, actor_type, actor_id,
		  action, resource_type, resource_id, request_id, user_agent, metadata)
		 VALUES ($1, COALESCE($2, gen_random_uuid()), $3, $4, $5, $6, $7,
		         'api_key', $8, $9, $10, $11)`, [
        input.eventKey,
        input.operationId ?? null,
        input.organizationId,
        input.projectId ?? null,
        auditActor(input.actorId),
        input.actorId?.slice(0, 256) ?? null,
        input.action,
        input.resourceId,
        input.requestId?.slice(0, 128) ?? null,
        auditUserAgentFingerprint(input.userAgent),
        input.metadata ?? {}
    ]);
};
/**
 * Linearize every user-initiated key lifecycle write against actor/user/org
 * disable, membership removal/role change, and organization deletion. `FOR
 * SHARE` is intentional: `FOR KEY SHARE` would still allow updates to the
 * non-key disabled_at and role columns while this transaction is minting or
 * enabling a bearer credential.
 */
const lockApiKeyAdministrator = async (client, organizationId, actorId) => {
    if (!actorId)
        return;
    const authorized = await client.query(`SELECT actor.id
		 FROM organizations organization
		 JOIN organization_members membership
		   ON membership.organization_id = organization.id
		 JOIN users actor ON actor.id = membership.user_id
		 WHERE organization.id = $1 AND actor.clerk_user_id = $2
		   AND organization.disabled_at IS NULL AND actor.disabled_at IS NULL
		   AND membership.role IN ('owner', 'admin')
		 FOR SHARE OF organization, membership, actor`, [organizationId, actorId]);
    if (!authorized.rowCount)
        throw new ApiKeyAuthorizationDenied();
};
export class PostgresApiKeyStore {
    database;
    constructor(database) {
        this.database = database;
    }
    async insert(record, actorId, audit) {
        try {
            await this.database.transaction(async (client) => {
                // Match the migration trigger's serialization order before taking
                // membership locks. This prevents concurrent writers from both
                // counting the same remaining quota slot or deadlocking on upgrades.
                await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
                    record.organizationId
                ]);
                await lockApiKeyAdministrator(client, record.organizationId, actorId);
                const inserted = await client.query(`INSERT INTO api_keys
					 (id, organization_id, project_id, name, prefix, key_hash, scopes, expires_at,
					  created_by)
					 SELECT $1, $2, $3, $4, $5, $6, $7, $8,
					  (SELECT id FROM users WHERE clerk_user_id = $9 AND disabled_at IS NULL)
					 FROM organizations organization
					 WHERE organization.id = $2 AND organization.disabled_at IS NULL
					   AND ($3::uuid IS NULL OR EXISTS (
					     SELECT 1 FROM projects WHERE id = $3 AND organization_id = $2
					   ))
					   AND ($9::text IS NULL OR EXISTS (
					     SELECT 1 FROM users actor
					     JOIN organization_members membership ON membership.user_id = actor.id
					     WHERE actor.clerk_user_id = $9 AND actor.disabled_at IS NULL
					       AND membership.organization_id = $2
					       AND membership.role IN ('owner', 'admin')
					   ))`, [
                    record.id,
                    record.organizationId,
                    record.projectId ?? null,
                    record.name,
                    record.prefix,
                    record.keyHash,
                    record.scopes,
                    record.expiresAt ?? null,
                    actorId ?? null
                ]);
                if (!inserted.rowCount) {
                    throw new InvalidApiKeyRequest('organization, project, or administrator is not currently available');
                }
                await insertAudit(client, {
                    eventKey: `api-key-created:${record.id}`,
                    organizationId: record.organizationId,
                    projectId: record.projectId,
                    actorId,
                    action: 'api_key.created',
                    resourceId: record.id,
                    requestId: audit?.requestId,
                    userAgent: audit?.userAgent
                });
            });
        }
        catch (error) {
            if (isPrefixCollision(error))
                throw new ApiKeyPrefixCollision();
            if (isAllocationQuotaExceeded(error))
                throw new ApiKeyQuotaExceeded();
            throw error;
        }
    }
    async list(organizationId, projectId) {
        const result = await this.database.query(`SELECT id, organization_id, project_id, name, prefix, scopes, created_at,
			        last_used_at, expires_at, disabled_at, revoked_at
			 FROM api_keys WHERE organization_id = $1
			   AND ($2::uuid IS NULL OR project_id = $2)
			 ORDER BY created_at DESC`, [organizationId, projectId ?? null]);
        return result.rows.map((row) => ({
            id: row.id,
            organizationId: row.organization_id,
            projectId: row.project_id ?? undefined,
            name: row.name,
            prefix: row.prefix,
            scopes: row.scopes,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at ?? undefined,
            expiresAt: row.expires_at ?? undefined,
            disabledAt: row.disabled_at ?? undefined,
            revokedAt: row.revoked_at ?? undefined
        }));
    }
    async findByPrefix(prefix) {
        const result = await this.database.query(`SELECT key.id, key.organization_id, key.project_id, key.name, key.prefix,
			        key.key_hash, key.scopes, key.expires_at, key.disabled_at,
			        organization.disabled_at AS organization_disabled_at, key.revoked_at
			 FROM api_keys key
			 JOIN organizations organization ON organization.id = key.organization_id
			 WHERE key.prefix = $1`, [prefix]);
        const row = result.rows[0];
        return row
            ? {
                id: row.id,
                organizationId: row.organization_id,
                projectId: row.project_id ?? undefined,
                name: row.name,
                prefix: row.prefix,
                keyHash: row.key_hash,
                scopes: row.scopes,
                expiresAt: row.expires_at ?? undefined,
                disabledAt: row.disabled_at ?? undefined,
                organizationDisabledAt: row.organization_disabled_at ?? undefined,
                revokedAt: row.revoked_at ?? undefined
            }
            : undefined;
    }
    async isActive(id, organizationId) {
        const result = await this.database.query(`SELECT 1 FROM api_keys key
			 JOIN organizations organization ON organization.id = key.organization_id
			 WHERE key.id = $1 AND key.organization_id = $2
			   AND key.disabled_at IS NULL AND key.revoked_at IS NULL
			   AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
			   AND organization.disabled_at IS NULL`, [id, organizationId]);
        return Boolean(result.rowCount);
    }
    async setDisabled(id, organizationId, disabled, actorId, audit) {
        return this.database.transaction(async (client) => {
            await lockApiKeyAdministrator(client, organizationId, actorId);
            const locked = await client.query(`SELECT id, project_id, disabled_at FROM api_keys
				 WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
				 FOR UPDATE`, [id, organizationId]);
            const key = locked.rows[0];
            if (!key)
                return false;
            const changed = disabled ? key.disabled_at === null : key.disabled_at !== null;
            if (changed) {
                await client.query(`UPDATE api_keys
					 SET disabled_at = CASE WHEN $3 THEN statement_timestamp() ELSE NULL END
					 WHERE id = $1 AND organization_id = $2`, [id, organizationId, disabled]);
                if (disabled) {
                    // Keep this explicit even though migration 0022 also installs a trigger:
                    // API-key lifecycle code owns the issuer revocation transaction.
                    await client.query(`UPDATE machine_gateway_grants
						 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
						 WHERE issuer_type = 'api_key' AND issuer_id = $1
						   AND organization_id = $2 AND revoked_at IS NULL`, [id, organizationId]);
                }
            }
            await insertAudit(client, {
                eventKey: `api-key-${disabled ? 'disabled' : 'enabled'}:${randomUUID()}`,
                organizationId,
                projectId: key.project_id ?? undefined,
                actorId,
                action: disabled ? 'api_key.disabled' : 'api_key.enabled',
                resourceId: id,
                requestId: audit?.requestId,
                userAgent: audit?.userAgent,
                metadata: { changed }
            });
            return true;
        });
    }
    async rotate(id, organizationId, replacement, actorId, audit) {
        try {
            return await this.database.transaction(async (client) => {
                await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [
                    organizationId
                ]);
                await lockApiKeyAdministrator(client, organizationId, actorId);
                const locked = await client.query(`SELECT key.project_id, key.name, key.scopes, key.expires_at
					 FROM api_keys key
					 JOIN organizations organization ON organization.id = key.organization_id
					 WHERE key.id = $1 AND key.organization_id = $2
					   AND key.disabled_at IS NULL AND key.revoked_at IS NULL
					   AND (key.expires_at IS NULL OR key.expires_at > statement_timestamp())
					   AND organization.disabled_at IS NULL
					 FOR UPDATE OF key`, [id, organizationId]);
                const previous = locked.rows[0];
                if (!previous)
                    return false;
                // Revoke first so a rotation is capacity-neutral at the trigger. The
                // transaction restores the original key and grants if insertion fails.
                await client.query('UPDATE api_keys SET revoked_at = statement_timestamp() WHERE id = $1', [
                    id
                ]);
                await client.query(`UPDATE machine_gateway_grants
					 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
					 WHERE issuer_type = 'api_key' AND issuer_id = $1
					   AND organization_id = $2 AND revoked_at IS NULL`, [id, organizationId]);
                await client.query(`INSERT INTO api_keys
					 (id, organization_id, project_id, name, prefix, key_hash, scopes, expires_at,
					  created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
					         (SELECT id FROM users WHERE clerk_user_id = $9 AND disabled_at IS NULL))`, [
                    replacement.id,
                    organizationId,
                    previous.project_id,
                    previous.name,
                    replacement.prefix,
                    replacement.keyHash,
                    previous.scopes,
                    previous.expires_at,
                    actorId ?? null
                ]);
                const operationId = randomUUID();
                await insertAudit(client, {
                    eventKey: `api-key-rotated:${id}`,
                    operationId,
                    organizationId,
                    projectId: previous.project_id ?? undefined,
                    actorId,
                    action: 'api_key.rotated',
                    resourceId: id,
                    requestId: audit?.requestId,
                    userAgent: audit?.userAgent,
                    metadata: { replacement_id: replacement.id }
                });
                await insertAudit(client, {
                    eventKey: `api-key-rotation-created:${replacement.id}`,
                    operationId,
                    organizationId,
                    projectId: previous.project_id ?? undefined,
                    actorId,
                    action: 'api_key.rotation_created',
                    resourceId: replacement.id,
                    requestId: audit?.requestId,
                    userAgent: audit?.userAgent,
                    metadata: { replaced_id: id }
                });
                return true;
            });
        }
        catch (error) {
            if (isPrefixCollision(error))
                throw new ApiKeyPrefixCollision();
            if (isAllocationQuotaExceeded(error))
                throw new ApiKeyQuotaExceeded();
            throw error;
        }
    }
    async revoke(id, organizationId, actorId, audit) {
        return this.database.transaction(async (client) => {
            await lockApiKeyAdministrator(client, organizationId, actorId);
            const result = await client.query(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, statement_timestamp())
				 WHERE id = $1 AND organization_id = $2 RETURNING id, project_id`, [id, organizationId]);
            if (!result.rowCount)
                return false;
            await client.query(`UPDATE machine_gateway_grants
				 SET revoked_at = COALESCE(revoked_at, statement_timestamp())
				 WHERE issuer_type = 'api_key' AND issuer_id = $1
				   AND organization_id = $2 AND revoked_at IS NULL`, [id, organizationId]);
            await client.query(`INSERT INTO audit_events
				 (event_key, organization_id, project_id, actor_type, actor_id, action,
				  resource_type, resource_id, request_id, user_agent)
				 VALUES ($1, $2, $3, $4, $5, 'api_key.revoked', 'api_key', $6, $7, $8)
				 ON CONFLICT (event_key) DO NOTHING`, [
                `api-key-revoked:${id}`,
                organizationId,
                result.rows[0]?.project_id ?? null,
                auditActor(actorId),
                actorId?.slice(0, 256) ?? null,
                id,
                audit?.requestId?.slice(0, 128) ?? null,
                auditUserAgentFingerprint(audit?.userAgent)
            ]);
            return true;
        });
    }
    async touch(id) {
        await this.database.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
    }
}
const parse = (raw) => {
    if (raw.length > 512)
        return undefined;
    const match = /^(bc_(?:live|test)_[a-f0-9]{12})_[A-Za-z0-9_-]{32,}$/.exec(raw);
    return match?.[1] ? { prefix: match[1] } : undefined;
};
/** Return only the public lookup prefix; never expose or retain key material. */
export const apiKeyPublicPrefix = (raw) => parse(raw)?.prefix;
const argonOptions = {
    algorithm: 2 /* Algorithm.Argon2id */,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32
};
// Generated once with the exact production Argon2id parameters above. It is
// non-secret and ensures a syntactically valid unknown prefix pays the same
// calibrated verifier cost as a known key.
export const apiKeyDummyHash = '$argon2id$v=19$m=19456,t=2,p=1$H5Y4yC5BsF4pyYmc1FjEEQ$1cI1NdYhgADdSVLKnM3Q11qDVv4SWcxk1tymUQvDX6Q';
class BoundedCryptoAdmission {
    concurrentLimit;
    queueLimit;
    busy;
    #waiters = [];
    #active = 0;
    constructor(concurrentLimit, queueLimit, busy) {
        this.concurrentLimit = concurrentLimit;
        this.queueLimit = queueLimit;
        this.busy = busy;
    }
    async run(operation) {
        if (this.#active < this.concurrentLimit) {
            this.#active += 1;
        }
        else {
            if (this.#waiters.length >= this.queueLimit)
                throw this.busy();
            await new Promise((resolve) => this.#waiters.push(resolve));
        }
        try {
            return await operation();
        }
        finally {
            const next = this.#waiters.shift();
            if (next)
                next();
            else
                this.#active -= 1;
        }
    }
}
const generateMaterial = () => ({
    publicId: randomBytes(6).toString('hex'),
    secret: randomBytes(32).toString('base64url')
});
const validateMaterial = (material) => {
    if (!/^[a-f0-9]{12}$/.test(material.publicId) || !/^[A-Za-z0-9_-]{43}$/.test(material.secret)) {
        throw new Error('API-key material generator returned an invalid value');
    }
};
const unknownId = '00000000-0000-4000-8000-000000000000';
const allocationAttempts = 5;
export class ApiKeyService {
    store;
    environment;
    #material;
    #hashSecret;
    #verifySecret;
    #now;
    #verificationAdmission;
    #hashAdmission;
    constructor(store, environment = 'live', dependencies = {}) {
        this.store = store;
        this.environment = environment;
        this.#material = dependencies.material ?? generateMaterial;
        this.#hashSecret = dependencies.hashSecret ?? ((raw) => hash(raw, argonOptions));
        this.#verifySecret = dependencies.verifySecret ?? verify;
        this.#now = dependencies.now ?? (() => new Date());
        const concurrent = dependencies.maxConcurrentVerifications ?? 4;
        const queued = dependencies.maxQueuedVerifications ?? 16;
        const concurrentHashes = dependencies.maxConcurrentHashes ?? 2;
        const queuedHashes = dependencies.maxQueuedHashes ?? 4;
        if (!Number.isSafeInteger(concurrent) ||
            concurrent < 1 ||
            concurrent > 64 ||
            !Number.isSafeInteger(queued) ||
            queued < 0 ||
            queued > 1_024 ||
            !Number.isSafeInteger(concurrentHashes) ||
            concurrentHashes < 1 ||
            concurrentHashes > 16 ||
            !Number.isSafeInteger(queuedHashes) ||
            queuedHashes < 0 ||
            queuedHashes > 256) {
            throw new Error('API-key cryptographic admission bounds are invalid');
        }
        this.#verificationAdmission = new BoundedCryptoAdmission(concurrent, queued, () => new ApiKeyVerifierBusy());
        this.#hashAdmission = new BoundedCryptoAdmission(concurrentHashes, queuedHashes, () => new ApiKeyHasherBusy());
    }
    #validateCreate(input) {
        if (!input.name.trim() || input.name.trim().length > 160) {
            throw new InvalidApiKeyRequest('API key name must contain 1 to 160 characters');
        }
        if (input.scopes.length === 0 || input.scopes.some((scope) => !apiKeyScopes.includes(scope))) {
            throw new InvalidApiKeyRequest('at least one valid API key scope is required');
        }
        if (input.projectId !== undefined &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.projectId)) {
            throw new InvalidApiKeyRequest('project_id must be a UUID');
        }
        if (input.expiresAt !== undefined &&
            (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= this.#now())) {
            throw new InvalidApiKeyRequest('expires_at must be a future timestamp');
        }
    }
    #credential() {
        const material = this.#material();
        validateMaterial(material);
        const prefix = `bc_${this.environment}_${material.publicId}`;
        return { id: randomUUID(), key: `${prefix}_${material.secret}`, prefix };
    }
    async create(input) {
        this.#validateCreate(input);
        for (let attempt = 0; attempt < allocationAttempts; attempt += 1) {
            const credential = this.#credential();
            const keyHash = await this.#hashAdmission.run(() => this.#hashSecret(credential.key));
            try {
                await this.store.insert({
                    id: credential.id,
                    organizationId: input.organizationId,
                    projectId: input.projectId,
                    name: input.name.trim(),
                    prefix: credential.prefix,
                    keyHash,
                    scopes: [...new Set(input.scopes)],
                    expiresAt: input.expiresAt
                }, input.actorId, { requestId: input.requestId, userAgent: input.userAgent });
                return credential;
            }
            catch (error) {
                if (error instanceof ApiKeyPrefixCollision && attempt < allocationAttempts - 1)
                    continue;
                if (error instanceof ApiKeyPrefixCollision)
                    throw new ApiKeyAllocationUnavailable();
                throw error;
            }
        }
        throw new ApiKeyAllocationUnavailable();
    }
    async authenticate(raw) {
        const parsed = parse(raw);
        if (!parsed)
            return undefined;
        const record = await this.store.findByPrefix(parsed.prefix);
        let verified = false;
        try {
            verified = await this.#verificationAdmission.run(() => this.#verifySecret(record?.keyHash ?? apiKeyDummyHash, raw));
        }
        catch (error) {
            if (error instanceof ApiKeyVerifierBusy)
                throw error;
            verified = false;
        }
        const active = await this.store.isActive(record?.id ?? unknownId, record?.organizationId ?? unknownId);
        if (!record ||
            !verified ||
            !active ||
            record.disabledAt ||
            record.organizationDisabledAt ||
            record.revokedAt ||
            (record.expiresAt && record.expiresAt <= this.#now())) {
            return undefined;
        }
        void this.store.touch(record.id).catch(() => undefined);
        return {
            kind: 'api_key',
            apiKeyId: record.id,
            organizationId: record.organizationId,
            projectId: record.projectId,
            scopes: new Set(record.scopes)
        };
    }
    disable(id, organizationId, actorId, audit) {
        return this.store.setDisabled(id, organizationId, true, actorId, audit);
    }
    enable(id, organizationId, actorId, audit) {
        return this.store.setDisabled(id, organizationId, false, actorId, audit);
    }
    async rotate(id, organizationId, actorId, audit) {
        for (let attempt = 0; attempt < allocationAttempts; attempt += 1) {
            const credential = this.#credential();
            const keyHash = await this.#hashAdmission.run(() => this.#hashSecret(credential.key));
            try {
                const rotated = await this.store.rotate(id, organizationId, { id: credential.id, prefix: credential.prefix, keyHash }, actorId, audit);
                return rotated ? credential : undefined;
            }
            catch (error) {
                if (error instanceof ApiKeyPrefixCollision && attempt < allocationAttempts - 1)
                    continue;
                if (error instanceof ApiKeyPrefixCollision)
                    throw new ApiKeyAllocationUnavailable();
                throw error;
            }
        }
        throw new ApiKeyAllocationUnavailable();
    }
    revoke(id, organizationId, actorId, audit) {
        return this.store.revoke(id, organizationId, actorId, audit);
    }
    list(organizationId, projectId) {
        return this.store.list(organizationId, projectId);
    }
}
export const hasScope = (principal, required) => principal.scopes.has(required);
//# sourceMappingURL=api-key.js.map