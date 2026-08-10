export interface NetworkPolicyDeclaration {
    readonly mode: 'off' | 'allowlist';
    readonly hostnames?: ReadonlyArray<string>;
    readonly cidrs?: ReadonlyArray<string>;
}
export declare const isHardBlockedAddress: (ip: string, additionalBlockedCidrs?: ReadonlyArray<string>) => boolean;
/**
 * Control-plane representation of strict egress. The host DNS interceptor uses
 * the same decisions: deny by default, clamp DNS TTL, and never learn a hard-floor address.
 */
export declare class EgressPolicy {
    #private;
    private readonly additionalBlockedCidrs;
    readonly declaration: NetworkPolicyDeclaration;
    constructor(declaration: NetworkPolicyDeclaration, additionalBlockedCidrs?: ReadonlyArray<string>);
    allowsHostname(hostname: string): boolean;
    learnDns(hostname: string, addresses: ReadonlyArray<string>, ttlSeconds: number, now?: number): void;
    allowsAddress(ip: string, now?: number): boolean;
}
