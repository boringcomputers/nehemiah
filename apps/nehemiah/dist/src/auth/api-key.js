import { randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
export const apiKeyScopes = [
    'machines:read',
    'machines:write',
    'templates:read',
    'templates:write',
    'billing:read'
];
export class PostgresApiKeyStore {
    database;
    constructor(database) {
        this.database = database;
    }
    async insert(record, actorId) {
        await this.database.query(`INSERT INTO api_keys
			 (id, organization_id, project_id, name, prefix, key_hash, scopes, expires_at, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
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
        await this.database.query(`INSERT INTO audit_events
			 (event_key, organization_id, actor_type, actor_id, action, resource_type, resource_id)
			 VALUES ($1, $2, 'user', $3, 'api_key.created', 'api_key', $4)`, [`api-key-created:${record.id}`, record.organizationId, actorId ?? null, record.id]);
    }
    async findByPrefix(prefix) {
        const result = await this.database.query(`SELECT id, organization_id, project_id, name, prefix, key_hash, scopes,
			        expires_at, revoked_at
			 FROM api_keys WHERE prefix = $1`, [prefix]);
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
                revokedAt: row.revoked_at ?? undefined
            }
            : undefined;
    }
    async revoke(id, organizationId, actorId) {
        const result = await this.database.query(`UPDATE api_keys SET revoked_at = now()
			 WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`, [id, organizationId]);
        if (!result.rowCount)
            return false;
        await this.database.query(`INSERT INTO audit_events
			 (event_key, organization_id, actor_type, actor_id, action, resource_type, resource_id)
			 VALUES ($1, $2, 'user', $3, 'api_key.revoked', 'api_key', $4)`, [`api-key-revoked:${id}`, organizationId, actorId ?? null, id]);
        return true;
    }
    async touch(id) {
        await this.database.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
    }
}
const parse = (raw) => {
    const match = /^(bc_(?:live|test)_[a-f0-9]{12})_[A-Za-z0-9_-]{32,}$/.exec(raw);
    return match?.[1] ? { prefix: match[1] } : undefined;
};
export class ApiKeyService {
    store;
    environment;
    constructor(store, environment = 'live') {
        this.store = store;
        this.environment = environment;
    }
    async create(input) {
        if (!input.name.trim())
            throw new Error('API key name is required');
        if (input.scopes.length === 0 || input.scopes.some((scope) => !apiKeyScopes.includes(scope))) {
            throw new Error('at least one valid API key scope is required');
        }
        const publicId = randomBytes(6).toString('hex');
        const prefix = `bc_${this.environment}_${publicId}`;
        const raw = `${prefix}_${randomBytes(32).toString('base64url')}`;
        const keyHash = await hash(raw, {
            algorithm: 2 /* Algorithm.Argon2id */,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
            outputLen: 32
        });
        const id = randomUUID();
        await this.store.insert({
            id,
            organizationId: input.organizationId,
            projectId: input.projectId,
            name: input.name.trim(),
            prefix,
            keyHash,
            scopes: [...new Set(input.scopes)],
            expiresAt: input.expiresAt
        }, input.actorId);
        return { id, key: raw, prefix };
    }
    async authenticate(raw) {
        const parsed = parse(raw);
        if (!parsed)
            return undefined;
        const record = await this.store.findByPrefix(parsed.prefix);
        if (!record || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) {
            return undefined;
        }
        if (!(await verify(record.keyHash, raw)))
            return undefined;
        void this.store.touch(record.id).catch(() => undefined);
        return {
            kind: 'api_key',
            apiKeyId: record.id,
            organizationId: record.organizationId,
            projectId: record.projectId,
            scopes: new Set(record.scopes)
        };
    }
    async revoke(id, organizationId, actorId) {
        return this.store.revoke(id, organizationId, actorId);
    }
}
export const hasScope = (principal, required) => principal.scopes.has(required);
//# sourceMappingURL=api-key.js.map