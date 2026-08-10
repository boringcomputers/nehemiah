export interface CredentialStore {
    get(account: string): Promise<string | undefined>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}
export declare class CredentialStoreUnavailable extends Error {
    readonly code = "credential_store_unavailable";
    constructor();
}
export interface StoredDeviceSession {
    readonly version: 1;
    readonly account: string;
    readonly origin: string;
    readonly refreshToken: string;
    readonly refreshExpiresAt: number;
    readonly accessToken: string;
    readonly accessExpiresAt: number;
    readonly organizationId: string;
    readonly projectId: string;
    readonly scopes: ReadonlyArray<string>;
}
export type StoredDeviceCredential = {
    readonly kind: 'legacy';
    readonly refreshToken: string;
} | {
    readonly kind: 'session';
    readonly session: StoredDeviceSession;
};
/** Strictly decodes only the bounded secret formats stored by released CLI versions. */
export declare function decodeDeviceCredential(secret: string): StoredDeviceCredential | undefined;
export declare function encodeDeviceSession(session: StoredDeviceSession): string;
/**
 * Stores the bounded access/refresh session in Keychain, Credential Manager, or
 * Secret Service through the maintained napi-rs keyring binding. No plaintext
 * fallback exists.
 */
export declare class SystemCredentialStore implements CredentialStore {
    #private;
    get(account: string): Promise<string | undefined>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}
