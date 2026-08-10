export declare class CredentialLockError extends Error {
    readonly code = "credential_lock_unavailable";
    constructor();
}
/** Serializes refresh-token rotation across CLI processes without storing a secret on disk. */
export declare function withCredentialLock<A>(configFile: string, account: string, operation: () => Promise<A>): Promise<A>;
