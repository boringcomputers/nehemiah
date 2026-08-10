import { Database } from '../db/client.js';
export declare const apiKeyScopes: readonly ["machines:read", "machines:write", "templates:read", "templates:write", "volumes:read", "volumes:write", "billing:read"];
export type ApiKeyScope = (typeof apiKeyScopes)[number];
export declare class InvalidApiKeyRequest extends Error {
    readonly code = "invalid_api_key";
}
export declare class ApiKeyPrefixCollision extends Error {
    readonly code = "api_key_prefix_collision";
}
export declare class ApiKeyAllocationUnavailable extends Error {
    readonly code = "api_key_allocation_unavailable";
}
export declare class ApiKeyAuthorizationDenied extends Error {
    readonly code = "api_key_administrator_required";
    constructor();
}
export declare class ApiKeyVerifierBusy extends Error {
    readonly code = "api_key_verifier_busy";
    constructor();
}
export declare class ApiKeyHasherBusy extends Error {
    readonly code = "api_key_hasher_busy";
    constructor();
}
export declare class ApiKeyQuotaExceeded extends Error {
    readonly code = "api_key_quota_exceeded";
    constructor();
}
export interface ApiKeyRecord {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId?: string;
    readonly name: string;
    readonly prefix: string;
    readonly keyHash: string;
    readonly scopes: ReadonlyArray<ApiKeyScope>;
    readonly expiresAt?: Date;
    readonly disabledAt?: Date;
    readonly organizationDisabledAt?: Date;
    readonly revokedAt?: Date;
    readonly createdAt?: Date;
    readonly lastUsedAt?: Date;
}
export type ApiKeySummary = Omit<ApiKeyRecord, 'keyHash' | 'organizationDisabledAt'>;
export interface ApiKeyAuditContext {
    readonly requestId?: string;
    readonly userAgent?: string;
}
export interface ApiKeyPrincipal {
    readonly kind: 'api_key';
    readonly apiKeyId: string;
    /** Present when this API-shaped principal was issued by a device refresh family. */
    readonly deviceFamilyId?: string;
    readonly organizationId: string;
    readonly projectId?: string;
    readonly scopes: ReadonlySet<ApiKeyScope>;
}
export interface ApiKeyStore {
    insert(record: ApiKeyRecord, actorId?: string, audit?: ApiKeyAuditContext): Promise<void>;
    findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
    isActive(id: string, organizationId: string): Promise<boolean>;
    list(organizationId: string, projectId?: string): Promise<ReadonlyArray<ApiKeySummary>>;
    setDisabled(id: string, organizationId: string, disabled: boolean, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    rotate(id: string, organizationId: string, replacement: Pick<ApiKeyRecord, 'id' | 'prefix' | 'keyHash'>, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    revoke(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    touch(id: string): Promise<void>;
}
export declare class PostgresApiKeyStore implements ApiKeyStore {
    private readonly database;
    constructor(database: Database);
    insert(record: ApiKeyRecord, actorId?: string, audit?: ApiKeyAuditContext): Promise<void>;
    list(organizationId: string, projectId?: string): Promise<ReadonlyArray<ApiKeySummary>>;
    findByPrefix(prefix: string): Promise<ApiKeyRecord | undefined>;
    isActive(id: string, organizationId: string): Promise<boolean>;
    setDisabled(id: string, organizationId: string, disabled: boolean, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    rotate(id: string, organizationId: string, replacement: Pick<ApiKeyRecord, 'id' | 'prefix' | 'keyHash'>, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    revoke(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    touch(id: string): Promise<void>;
}
/** Return only the public lookup prefix; never expose or retain key material. */
export declare const apiKeyPublicPrefix: (raw: string) => string | undefined;
export declare const apiKeyDummyHash = "$argon2id$v=19$m=19456,t=2,p=1$H5Y4yC5BsF4pyYmc1FjEEQ$1cI1NdYhgADdSVLKnM3Q11qDVv4SWcxk1tymUQvDX6Q";
export interface ApiKeyMaterial {
    readonly publicId: string;
    readonly secret: string;
}
export interface ApiKeyServiceDependencies {
    readonly material?: () => ApiKeyMaterial;
    readonly hashSecret?: (raw: string) => Promise<string>;
    readonly verifySecret?: (encoded: string, raw: string) => Promise<boolean>;
    readonly now?: () => Date;
    readonly maxConcurrentVerifications?: number;
    readonly maxQueuedVerifications?: number;
    readonly maxConcurrentHashes?: number;
    readonly maxQueuedHashes?: number;
}
export declare class ApiKeyService {
    #private;
    private readonly store;
    private readonly environment;
    constructor(store: ApiKeyStore, environment?: 'live' | 'test', dependencies?: ApiKeyServiceDependencies);
    create(input: {
        organizationId: string;
        projectId?: string;
        name: string;
        scopes: ReadonlyArray<ApiKeyScope>;
        expiresAt?: Date;
        actorId?: string;
        requestId?: string;
        userAgent?: string;
    }): Promise<{
        id: string;
        key: string;
        prefix: string;
    }>;
    authenticate(raw: string): Promise<ApiKeyPrincipal | undefined>;
    disable(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    enable(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    rotate(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<{
        id: string;
        key: string;
        prefix: string;
    } | undefined>;
    revoke(id: string, organizationId: string, actorId?: string, audit?: ApiKeyAuditContext): Promise<boolean>;
    list(organizationId: string, projectId?: string): Promise<ReadonlyArray<ApiKeySummary>>;
}
export declare const hasScope: (principal: ApiKeyPrincipal, required: ApiKeyScope) => boolean;
