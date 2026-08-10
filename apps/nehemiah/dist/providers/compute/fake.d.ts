import type { ComputeProvider, ProviderHost, ProvisionHostRequest } from './provider.js';
export declare class FakeComputeProvider implements ComputeProvider {
    #private;
    readonly hosts: Map<string, ProviderHost>;
    readonly idempotency: Map<string, string>;
    listCapacity(): Promise<ReadonlyArray<ProviderHost>>;
    provisionHost(request: ProvisionHostRequest): Promise<ProviderHost>;
    getHost(id: string): Promise<ProviderHost | undefined>;
    deleteHost(id: string): Promise<void>;
}
