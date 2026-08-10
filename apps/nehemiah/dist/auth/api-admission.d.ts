import type { Queryable } from '../db/client.js';
export interface ApiRateLimitConfig {
    readonly enabled: boolean;
    readonly windowSeconds: number;
    readonly preAuthIpRequests: number;
    readonly preAuthApiKeyRequests: number;
    readonly principalRequests: number;
    readonly organizationRequests: number;
    readonly projectRequests: number;
    readonly failClosed: boolean;
}
export interface AdmissionIdentity {
    readonly principalId: string;
    readonly organizationId?: string;
    readonly projectId?: string;
}
export interface ApiAdmission {
    preAuthenticate(request: Request, token?: string): Promise<void>;
    authenticate(identity: AdmissionIdentity): Promise<void>;
}
export declare class ApiRateLimitExceeded extends Error {
    readonly retryAfterSeconds: number;
    readonly code = "rate_limit_exceeded";
    constructor(retryAfterSeconds: number);
}
export declare class ApiAdmissionUnavailable extends Error {
    readonly code = "api_admission_unavailable";
    constructor();
}
/**
 * Collapse public addresses to /24 (IPv4) or /56 (IPv6). The source header is
 * installed by main.ts only after direct-socket or gateway-HMAC validation.
 */
export declare const coarseClientIdentity: (raw: string | null) => string;
export declare class PostgresApiAdmission implements ApiAdmission {
    private readonly database;
    private readonly config;
    constructor(database: Queryable, config: ApiRateLimitConfig);
    preAuthenticate(request: Request, token?: string): Promise<void>;
    authenticate(identity: AdmissionIdentity): Promise<void>;
    private consume;
}
