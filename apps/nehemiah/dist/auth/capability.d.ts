export declare const gatewayCapabilities: readonly ["tty", "vnc", "agent", "files", "preview"];
export type GatewayCapability = (typeof gatewayCapabilities)[number];
export declare const canonicalGatewayCapabilities: (capabilities: ReadonlyArray<GatewayCapability>) => GatewayCapability[];
export interface CapabilityClaims {
    readonly machineId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly leaseId: string;
    readonly capabilities: ReadonlyArray<GatewayCapability>;
    readonly port?: number;
}
export interface CapabilityIssueOptions {
    /** Durable grant/session identity copied into the JWT jti claim. */
    readonly capabilityId?: string;
    /** Explicit clock used when a durable grant must share the exact JWT expiry. */
    readonly issuedAt?: Date;
}
export declare const issueCapabilityToken: (claims: CapabilityClaims, secret: string, ttlSeconds?: number, options?: CapabilityIssueOptions) => Promise<string>;
export declare const verifyCapabilityToken: (token: string, secret: string) => Promise<CapabilityClaims>;
