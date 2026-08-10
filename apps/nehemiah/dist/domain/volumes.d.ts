import { BillingAdmissionPolicy } from '../billing/admission.js';
import { Database } from '../db/client.js';
export declare const defaultVolumeSizeLimitMb = 10240;
export declare const defaultVolumeTtlSeconds: number;
export declare const maximumVolumeTtlSeconds: number;
export declare const volumeDeletionRetentionSeconds: number;
export declare const defaultVolumeGrantTtlSeconds = 300;
export declare const maximumVolumeGrantTtlSeconds = 900;
export type VolumeGrantMethod = 'GET' | 'PUT';
export interface Volume {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly objectPrefix: string;
    readonly sizeLimitBytes: number;
    readonly observedSizeBytes: number;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly deletedAt?: Date;
    /** Durable create identity. It is never included in API responses. */
    readonly idempotencyKey?: string;
    readonly createRequestHash?: string;
}
export interface VolumeWriteGrantReservation {
    readonly id: string;
    readonly volumeId: string;
    readonly maximumBytes: number;
    readonly expiresAt: Date;
}
export interface VolumeDeletionJob {
    readonly volume: Volume;
    readonly deleteAfter: Date;
    readonly attemptCount: number;
    readonly claimToken: string;
}
/**
 * A short-lived, presigned operation. The adapter must scope it to exactly one
 * tenant volume prefix. Long-lived object-store credentials are never part of
 * this control-plane contract.
 */
export interface VolumeObjectGrant {
    readonly method: VolumeGrantMethod;
    readonly url: string;
    readonly objectPrefix: string;
    readonly expiresAt: Date;
    readonly encryptionAtRest: true;
    readonly headers?: Readonly<Record<string, string>>;
    /** Required for PUT grants so the adapter enforces the remaining allocation. */
    readonly maximumBytes?: number;
}
export interface VolumeObjectStore {
    /**
     * Adapters that cannot delegate a future deletion to the provider keep the
     * durable outbox pending until the retention boundary, then delete the exact
     * prefix themselves. Absence preserves the external-scheduler contract.
     */
    readonly deletionMode?: 'at-retention-boundary';
    /**
     * Additional time that a write reservation remains charged after its public
     * capability expires. This closes the provider commit/visibility window for
     * a broker that aborts an in-flight upload at capability expiry.
     */
    readonly reservationSettlementSeconds?: number;
    inspect(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
    }): Promise<{
        readonly observedSizeBytes: number;
    }>;
    issueGrant(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
        readonly method: VolumeGrantMethod;
        /** Public capability deadline; expiresAt may include a private settlement hold. */
        readonly capabilityExpiresAt?: Date;
        readonly expiresAt: Date;
        readonly maximumBytes?: number;
        readonly requireEncryptionAtRest: true;
        /**
         * Required for PUT. Repeated calls with the same reservation ID must
         * return the same effective grant rather than minting another upload
         * capability. This is the object-store half of fail-closed retries.
         */
        readonly reservationId?: string;
    }): Promise<VolumeObjectGrant>;
    /** Schedule or execute retained object deletion; this must be idempotent. */
    scheduleDeletion(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly objectPrefix: string;
        readonly deleteAfter: Date;
    }): Promise<void>;
}
export interface VolumeRepository {
    admitCreate(volume: Volume, idempotencyKey: string, requestHash: string): Promise<{
        readonly volume: Volume;
        readonly replayed: boolean;
    }>;
    list(organizationId: string, projectId: string | undefined, now: Date): Promise<Volume[]>;
    find(id: string, organizationId: string, projectId: string | undefined, now: Date): Promise<Volume | undefined>;
    findForDeletion(id: string, organizationId: string, projectId?: string): Promise<Volume | undefined>;
    updateObservedSize(id: string, organizationId: string, observedSizeBytes: number): Promise<boolean>;
    reserveWriteGrant(input: {
        readonly id: string;
        readonly organizationId: string;
        readonly projectId?: string;
        readonly observedSizeBytes: number;
        readonly now: Date;
        readonly expiresAt: Date;
        readonly operationKey?: string;
    }): Promise<{
        readonly volume: Volume;
        readonly reservation: VolumeWriteGrantReservation;
    } | undefined>;
    markWriteGrantIssued(reservationId: string, organizationId: string, now: Date): Promise<boolean>;
    enqueueDeletion(input: {
        readonly id: string;
        readonly organizationId: string;
        readonly projectId?: string;
        readonly requestedAt: Date;
        readonly observedSizeBytes: number;
    }): Promise<{
        readonly volume: Volume;
        readonly deleteAfter: Date;
    } | undefined>;
    enqueueExpiredDeletions(now: Date, limit: number): Promise<number>;
    claimDeletionJobs(input: {
        readonly now: Date;
        readonly limit: number;
        readonly claimToken: string;
        readonly claimTtlSeconds: number;
    }): Promise<VolumeDeletionJob[]>;
    markDeletionScheduled(volumeId: string, scheduledAt: Date): Promise<boolean>;
    deferDeletion(input: {
        readonly volumeId: string;
        readonly now: Date;
        readonly nextAttemptAt: Date;
        readonly claimToken?: string;
        readonly errorCode: string;
    }): Promise<boolean>;
}
export declare class InvalidVolumeRequest extends Error {
    readonly code = "invalid_volume_request";
}
export declare class VolumeProjectUnavailable extends Error {
    readonly code = "volume_project_not_found";
}
export declare class VolumeQuotaExceeded extends Error {
    readonly code = "storage_quota_exceeded";
}
export declare class VolumeIdempotencyConflict extends Error {
    readonly code = "idempotency_conflict";
}
export declare class VolumeInfrastructureUnavailable extends Error {
    readonly code = "volume_infrastructure_unavailable";
}
export declare class VolumeIntegrityError extends Error {
    readonly code = "volume_integrity_failed";
}
export declare class PostgresVolumeRepository implements VolumeRepository {
    private readonly database;
    private readonly billingAdmission;
    constructor(database: Database, billingAdmission?: BillingAdmissionPolicy);
    admitCreate(volume: Volume, idempotencyKey: string, requestHash: string): Promise<{
        readonly volume: Volume;
        readonly replayed: boolean;
    }>;
    list(organizationId: string, projectId: string | undefined, now: Date): Promise<Volume[]>;
    find(id: string, organizationId: string, projectId: string | undefined, now: Date): Promise<Volume | undefined>;
    findForDeletion(id: string, organizationId: string, projectId?: string): Promise<Volume | undefined>;
    updateObservedSize(id: string, organizationId: string, observedSizeBytes: number): Promise<boolean>;
    reserveWriteGrant(input: {
        readonly id: string;
        readonly organizationId: string;
        readonly projectId?: string;
        readonly observedSizeBytes: number;
        readonly now: Date;
        readonly expiresAt: Date;
        readonly operationKey?: string;
    }): Promise<{
        readonly volume: Volume;
        readonly reservation: VolumeWriteGrantReservation;
    } | undefined>;
    markWriteGrantIssued(reservationId: string, organizationId: string, now: Date): Promise<boolean>;
    enqueueDeletion(input: {
        readonly id: string;
        readonly organizationId: string;
        readonly projectId?: string;
        readonly requestedAt: Date;
        readonly observedSizeBytes: number;
    }): Promise<{
        readonly volume: Volume;
        readonly deleteAfter: Date;
    } | undefined>;
    enqueueExpiredDeletions(now: Date, limit: number): Promise<number>;
    claimDeletionJobs(input: {
        readonly now: Date;
        readonly limit: number;
        readonly claimToken: string;
        readonly claimTtlSeconds: number;
    }): Promise<VolumeDeletionJob[]>;
    markDeletionScheduled(volumeId: string, scheduledAt: Date): Promise<boolean>;
    deferDeletion(input: {
        readonly volumeId: string;
        readonly now: Date;
        readonly nextAttemptAt: Date;
        readonly claimToken?: string;
        readonly errorCode: string;
    }): Promise<boolean>;
}
export declare class VolumeService {
    #private;
    private readonly storage?;
    private readonly now;
    constructor(repository: VolumeRepository | Database, storage?: VolumeObjectStore | undefined, now?: () => Date);
    create(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly sizeLimitMb?: number;
        readonly ttlSeconds?: number;
        readonly grantTtlSeconds?: number;
        readonly idempotencyKey: string;
    }): Promise<{
        readonly volume: Volume;
        readonly grant: VolumeObjectGrant;
        readonly replayed: boolean;
    }>;
    list(organizationId: string, projectId?: string): Promise<Volume[]>;
    get(id: string, organizationId: string, projectId?: string): Promise<Volume | undefined>;
    grant(id: string, organizationId: string, projectId: string | undefined, method: VolumeGrantMethod, ttlSeconds?: number): Promise<{
        readonly volume: Volume;
        readonly grant: VolumeObjectGrant;
    } | undefined>;
    remove(id: string, organizationId: string, projectId?: string): Promise<{
        readonly volume: Volume;
        readonly deleteAfter: Date;
    } | undefined>;
}
export declare const volumeJson: (volume: Volume, deleteAfter?: Date) => {
    id: string;
    project_id: string;
    created_at: string;
    expires_at: string;
    quota_mb: number;
    used_bytes: number;
    deleted_at: string | undefined;
    delete_after: string | undefined;
};
export declare const volumeGrantJson: (grant: VolumeObjectGrant) => {
    method: VolumeGrantMethod;
    url: string;
    headers: Readonly<Record<string, string>>;
    expires_at: string;
    maximum_bytes: number | undefined;
};
