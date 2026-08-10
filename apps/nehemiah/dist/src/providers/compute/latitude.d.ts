import type { ComputeProvider, ProviderHost, ProvisionHostRequest } from './provider.js';
export declare class LatitudeProvider implements ComputeProvider {
    private readonly token;
    private readonly fetcher;
    private readonly baseUrl;
    constructor(token: string, fetcher?: typeof fetch, baseUrl?: string);
    listCapacity(): Promise<ReadonlyArray<ProviderHost>>;
    provisionHost(request: ProvisionHostRequest): Promise<ProviderHost>;
    getHost(id: string): Promise<ProviderHost | undefined>;
    deleteHost(id: string): Promise<void>;
    private request;
}
export declare class LatitudeError extends Error {
    readonly status: number;
    readonly responseBody: string;
    constructor(status: number, responseBody: string);
}
