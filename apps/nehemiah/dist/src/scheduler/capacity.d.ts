export interface Resources {
    readonly vcpus: number;
    readonly memoryMb: number;
    readonly diskMb: number;
}
export interface HostCapacity extends Resources {
    readonly id: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly state: 'ready' | 'draining' | 'unhealthy' | 'stale';
    readonly reservedVcpus: number;
    readonly reservedMemoryMb: number;
    readonly reservedDiskMb: number;
    readonly cachedTemplates: ReadonlySet<string>;
}
export declare const available: (host: HostCapacity) => Resources;
export declare const fits: (host: HostCapacity, resources: Resources) => boolean;
export declare const validateResources: (resources: Resources) => void;
