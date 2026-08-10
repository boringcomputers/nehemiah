export declare class HostCredentialRateLimitExceeded extends Error {
    readonly retryAfterSeconds: number;
    readonly code = "host_credential_rate_limited";
    constructor(retryAfterSeconds: number);
}
export declare class HostCredentialVerifierBusy extends Error {
    readonly code = "host_credential_verifier_busy";
    constructor();
}
export interface HostCredentialAdmissionOptions {
    readonly slots?: number;
    readonly requestsPerSecond?: number;
    readonly maximumConcurrentVerifications?: number;
    readonly now?: () => number;
}
/**
 * A cheap process-local shield in front of Argon2. Slots are deliberately
 * collision-conservative: colliding peers share a budget rather than evicting
 * one another or growing attacker-controlled state. PostgreSQL remains the
 * cross-replica authority after the host has authenticated.
 */
export declare class HostCredentialAdmission {
    #private;
    constructor(options?: HostCredentialAdmissionOptions);
    verify<A>(request: Request, hostId: string, operation: () => Promise<A>): Promise<A>;
}
