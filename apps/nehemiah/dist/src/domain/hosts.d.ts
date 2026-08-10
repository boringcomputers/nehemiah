import type { Queryable } from '../db/client.js';
import type { HostState } from '../db/schema.js';
export interface HostHeartbeat {
    readonly state: Exclude<HostState, 'stale'>;
    readonly availableVcpus: number;
    readonly availableMemoryMb: number;
    readonly availableDiskMb: number;
    readonly machineCount: number;
    readonly kvmAvailable: boolean;
    readonly daemonVersion: string;
}
export interface RegisterHost {
    readonly providerId?: string;
    readonly regionId: string;
    readonly address: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly totalVcpus: number;
    readonly totalMemoryMb: number;
    readonly totalDiskMb: number;
}
export declare class HostService {
    private readonly database;
    constructor(database: Queryable);
    register(input: RegisterHost): Promise<{
        id: string;
        credential: string;
    }>;
    authenticate(hostId: string, credential: string): Promise<boolean>;
    heartbeat(hostId: string, heartbeat: HostHeartbeat): Promise<void>;
    markStale(staleAfterMs: number): Promise<ReadonlyArray<string>>;
    setDraining(hostId: string, draining: boolean): Promise<boolean>;
}
