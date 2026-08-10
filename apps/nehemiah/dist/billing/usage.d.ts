import type { Queryable } from '../db/client.js';
import type { MeterDimension } from './rates.js';
export interface UsageEvent {
    readonly eventKey: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly machineId?: string;
    readonly dimension: MeterDimension;
    readonly quantity: number;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly source: 'control-plane' | 'host' | 'reconciler';
}
export declare class UsageLedger {
    private readonly database;
    constructor(database: Queryable);
    append(event: UsageEvent): Promise<boolean>;
    recordMachineRuntime(input: {
        eventPrefix: string;
        organizationId: string;
        projectId: string;
        machineId: string;
        vcpus: number;
        memoryMb: number;
        start: Date;
        end: Date;
        source: UsageEvent['source'];
    }): Promise<void>;
}
