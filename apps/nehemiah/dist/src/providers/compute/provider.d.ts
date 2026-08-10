export interface ProviderHost {
    readonly id: string;
    readonly hostname: string;
    readonly status: string;
    readonly region: string;
    readonly primaryIpv4?: string;
    readonly plan?: string;
}
export interface ProvisionHostRequest {
    readonly project: string;
    readonly plan: string;
    readonly site: string;
    readonly operatingSystem: string;
    readonly hostname: string;
    readonly userData?: string;
    readonly idempotencyKey: string;
}
export interface ComputeProvider {
    listCapacity(): Promise<ReadonlyArray<ProviderHost>>;
    provisionHost(request: ProvisionHostRequest): Promise<ProviderHost>;
    getHost(id: string): Promise<ProviderHost | undefined>;
    deleteHost(id: string): Promise<void>;
}
