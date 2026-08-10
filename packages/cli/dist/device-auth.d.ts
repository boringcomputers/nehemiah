export declare const cliDeviceScopes: readonly ["machines:read", "machines:write", "templates:read", "templates:write", "volumes:read", "volumes:write"];
export interface DeviceCodeResponse {
    readonly device_code: string;
    readonly user_code: string;
    readonly verification_uri: string;
    readonly verification_uri_complete: string;
    readonly expires_in: number;
    readonly interval: number;
    readonly scopes: ReadonlyArray<string>;
}
export interface DeviceTokenResponse {
    readonly token_type: 'Bearer';
    readonly access_token: string;
    readonly expires_in: number;
    readonly refresh_token: string;
    readonly refresh_expires_in: number;
    readonly organization_id: string;
    readonly project_id: string;
    readonly scopes: ReadonlyArray<string>;
}
export declare class DeviceAuthError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly retryAfterSeconds?: number;
    constructor(code: string, message: string, options?: {
        readonly status?: number;
        readonly retryAfterSeconds?: number;
    });
}
export interface DeviceRequestOptions {
    readonly timeoutMs?: number;
}
export declare function requestDeviceCode(baseUrl: string, scopes: ReadonlyArray<string>, fetchImplementation: typeof globalThis.fetch, options?: DeviceRequestOptions): Promise<DeviceCodeResponse>;
export declare function exchangeDeviceCode(baseUrl: string, deviceCode: string, fetchImplementation: typeof globalThis.fetch, options?: DeviceRequestOptions): Promise<DeviceTokenResponse>;
export declare function refreshDeviceToken(baseUrl: string, refreshToken: string, fetchImplementation: typeof globalThis.fetch, options?: DeviceRequestOptions): Promise<DeviceTokenResponse>;
export declare function revokeDeviceToken(baseUrl: string, refreshToken: string, fetchImplementation: typeof globalThis.fetch, options?: DeviceRequestOptions): Promise<void>;
export declare function pollDeviceToken(input: {
    readonly baseUrl: string;
    readonly code: DeviceCodeResponse;
    readonly fetch: typeof globalThis.fetch;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
    readonly requestTimeoutMs?: number;
}): Promise<DeviceTokenResponse>;
export declare const openVerificationPage: (url: string, baseUrl: string, platform?: NodeJS.Platform) => Promise<void>;
