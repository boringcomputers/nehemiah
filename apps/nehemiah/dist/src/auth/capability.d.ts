export declare const gatewayCapabilities: readonly ["tty", "vnc", "agent", "files", "preview"];
export type GatewayCapability = (typeof gatewayCapabilities)[number];
export interface CapabilityClaims {
    readonly machineId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly capabilities: ReadonlyArray<GatewayCapability>;
    readonly port?: number;
}
export declare const issueCapabilityToken: (claims: CapabilityClaims, secret: string, ttlSeconds?: number) => Promise<string>;
export declare const verifyCapabilityToken: (token: string, secret: string) => Promise<CapabilityClaims>;
