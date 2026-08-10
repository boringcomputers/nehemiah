import { BillingAdmissionPolicy } from '../billing/admission.js';
import { Database } from '../db/client.js';
import { type Resources } from './capacity.js';
export interface ScheduleRequest {
    readonly organizationId: string;
    readonly projectId: string;
    readonly region: string;
    readonly architecture: 'x86_64' | 'aarch64';
    readonly resources: Resources;
    readonly templateId?: string;
    readonly machineId?: string;
}
export interface Reservation {
    readonly hostId: string;
    readonly address: string;
    readonly cachedTemplate: boolean;
    readonly runtimeCohortId?: string;
    readonly sourceSha256?: string;
    /** True when the scheduler atomically persisted the machine assignment. */
    readonly assignmentCommitted?: boolean;
}
export declare class CapacityUnavailable extends Error {
    readonly code = "capacity_unavailable";
}
export declare class QuotaExceeded extends Error {
    readonly code = "quota_exceeded";
}
export declare class Scheduler {
    private readonly database;
    private readonly billingAdmission;
    constructor(database: Database, billingAdmission?: BillingAdmissionPolicy);
    reserve(request: ScheduleRequest): Promise<Reservation>;
    release(hostId: string, resources: Resources, machineId?: string): Promise<void>;
    private enforceQuota;
}
