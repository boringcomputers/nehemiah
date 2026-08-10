import { Database } from '../db/client.js';
import { type Resources } from './capacity.js';
export interface ScheduleRequest {
    readonly organizationId: string;
    readonly projectId: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly templateId?: string;
}
export interface Reservation {
    readonly hostId: string;
    readonly address: string;
    readonly cachedTemplate: boolean;
}
export declare class CapacityUnavailable extends Error {
    readonly code = "capacity_unavailable";
}
export declare class QuotaExceeded extends Error {
    readonly code = "quota_exceeded";
}
export declare class Scheduler {
    private readonly database;
    constructor(database: Database);
    reserve(request: ScheduleRequest): Promise<Reservation>;
    release(hostId: string, resources: Resources): Promise<void>;
    private enforceQuota;
}
