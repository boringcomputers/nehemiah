import { type ApiKeyPrincipal, type ApiKeyScope } from './api-key.js';
import { Database } from '../db/client.js';
export type DeviceDecision = 'approve' | 'deny';
export declare class DeviceAuthorizationError extends Error {
    readonly code: 'invalid_request' | 'invalid_client' | 'invalid_scope' | 'invalid_grant' | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'refresh_reuse_detected' | 'rate_limited';
    readonly status: 400 | 403 | 404 | 409 | 429;
    readonly retryAfterSeconds?: number | undefined;
    constructor(code: 'invalid_request' | 'invalid_client' | 'invalid_scope' | 'invalid_grant' | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'refresh_reuse_detected' | 'rate_limited', message: string, status?: 400 | 403 | 404 | 409 | 429, retryAfterSeconds?: number | undefined);
}
export interface DeviceCodeResponse {
    readonly device_code: string;
    readonly user_code: string;
    readonly verification_uri: string;
    readonly verification_uri_complete: string;
    readonly expires_in: number;
    readonly interval: number;
    readonly scopes: ReadonlyArray<ApiKeyScope>;
}
export interface DeviceRequestSummary {
    readonly client_id: string;
    readonly scopes: ReadonlyArray<ApiKeyScope>;
    readonly expires_at: string;
    readonly status: 'pending';
}
export interface DeviceTokenResponse {
    readonly token_type: 'Bearer';
    readonly access_token: string;
    readonly expires_in: number;
    readonly refresh_token: string;
    readonly refresh_expires_in: number;
    readonly organization_id: string;
    readonly project_id: string;
    readonly scopes: ReadonlyArray<ApiKeyScope>;
}
export declare class DeviceAuthorizationService {
    #private;
    private readonly database;
    private readonly now;
    constructor(database: Database, verificationUrl: string, lookupPepper: string, now?: () => Date);
    issue(input: {
        readonly clientId: string;
        readonly scopes: ReadonlyArray<unknown>;
        readonly source: string;
        readonly requestId?: string;
        readonly userAgent?: string;
    }): Promise<DeviceCodeResponse>;
    inspect(input: {
        readonly userCode: string;
        readonly actorId: string;
    }): Promise<DeviceRequestSummary>;
    authorize(input: {
        readonly userCode: string;
        readonly decision: DeviceDecision;
        readonly organizationId: string;
        readonly projectId?: string;
        readonly scopes?: ReadonlyArray<unknown>;
        readonly clerkUserId: string;
        readonly requestId?: string;
        readonly userAgent?: string;
    }): Promise<void>;
    exchange(deviceCode: string, context?: {
        requestId?: string;
        userAgent?: string;
    }): Promise<DeviceTokenResponse>;
    refresh(refreshToken: string, context?: {
        requestId?: string;
        userAgent?: string;
    }): Promise<DeviceTokenResponse>;
    revoke(refreshToken: string, context?: {
        requestId?: string;
        userAgent?: string;
    }): Promise<boolean>;
    authenticateAccess(raw: string, context?: {
        requestId?: string;
        userAgent?: string;
    }): Promise<ApiKeyPrincipal | undefined>;
}
