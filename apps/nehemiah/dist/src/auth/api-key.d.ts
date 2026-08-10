import type { Queryable } from '../db/client.js';
export declare const apiKeyScopes: readonly ["machines:read", "machines:write", "templates:read", "templates:write", "billing:read"];
export type ApiKeyScope = (typeof apiKeyScopes)[number];
export interface ApiKeyRecord {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId?: string;
    readonly name: string;
    readonly prefix: string;
    readonly keyHash: string;
    readonly scopes: ReadonlyArray<ApiKeyScope>;
    readonly expiresAt?: Date;
    readonly revokedAt?: Date;
}
export interface ApiKeyPrincipal {
    readonly kind: 'api_key';
    readonly apiKeyId: string;
    readonly organizationId: string;
    readonly projectId?: string;
    readonly scopes: ReadonlySet<ApiKeyScope>;
}
export interface ApiKeyStore {
    insert(record: ApiKeyRecord, actorId?: string): Promise<void>;
    findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
    revoke(id: string, organizationId: string, actorId?: string): Promise<boolean>;
    touch(id: string): Promise<void>;
}
export declare class PostgresApiKeyStore implements ApiKeyStore {
    private readonly database;
    constructor(database: Queryable);
    insert(record: ApiKeyRecord, actorId?: string): Promise<void>;
    findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
    revoke(id: string, organizationId: string, actorId?: string): Promise<boolean>;
    touch(id: string): Promise<void>;
}
export declare class ApiKeyService {
    private readonly store;
    private readonly environment;
    constructor(store: ApiKeyStore, environment?: 'live' | 'test');
    create(input: {
        organizationId: string;
        projectId?: string;
        name: string;
        scopes: ReadonlyArray<ApiKeyScope>;
        expiresAt?: Date;
        actorId?: string;
    }): Promise<{
        id: string;
        key: string;
        prefix: string;
    }>;
    authenticate(raw: string): Promise<ApiKeyPrincipal | undefined>;
    revoke(id: string, organizationId: string, actorId?: string): Promise<boolean>;
}
export declare const hasScope: (principal: ApiKeyPrincipal, required: ApiKeyScope) => boolean;
