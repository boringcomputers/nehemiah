import type { Database } from '../db/client.js';
export type StreamAuthorityKind = 'machine_capability' | 'volume_capability';
export interface StreamAdmissionRequest {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly authorityKind: StreamAuthorityKind;
    readonly authorityId: string;
    readonly instanceId: string;
    readonly bandwidthBytesPerSecond: number;
}
export interface StreamLease {
    readonly id: string;
    readonly bandwidthBytesPerSecond: number;
    readonly expiresAt: Date;
}
export interface StreamRequestRateConfig {
    readonly windowSeconds: number;
    readonly authorityRequests: number;
    readonly projectRequests: number;
    readonly organizationRequests: number;
}
export declare class StreamAdmissionRejected extends Error {
    readonly code = "stream_quota_exceeded";
}
export declare class StreamRequestRateExceeded extends Error {
    readonly retryAfterSeconds: number;
    readonly code = "stream_request_rate_exceeded";
    constructor(retryAfterSeconds: number);
}
export declare class InvalidStreamAdmission extends Error {
    readonly code = "invalid_stream_admission";
}
/**
 * PostgreSQL is the global stream authority shared by every gateway and object
 * broker replica. The organization row is always locked before the project row,
 * matching other admission paths and serializing both quota dimensions.
 */
export declare class StreamAdmissionService {
    private readonly database;
    private readonly requestRate;
    static readonly leaseSeconds = 15;
    constructor(database: Database, requestRate?: StreamRequestRateConfig);
    /**
     * Consume global request admission before an exact capability route lookup.
     * Revalidation of an exact, unexpired durable stream lease is free; all new
     * stream identities consume simultaneous capability, project, and organization
     * windows. Hash collisions only deny extra work and can never grant capacity.
     */
    admitRouteRequest(request: StreamAdmissionRequest): Promise<void>;
    acquire(request: StreamAdmissionRequest): Promise<StreamLease>;
    release(id: string, instanceId: string): Promise<void>;
    reapExpired(limit?: number): Promise<number>;
}
