import type { Database } from '../db/client.js';
import { type VolumeObjectStore, type VolumeRepository } from '../domain/volumes.js';
export declare const volumeDeletionClaimTtlSeconds = 60;
export declare const volumeDeletionBatchSize = 100;
export declare const volumeDeletionRetryDelayMs: (attemptCount: number) => number;
export interface VolumeDeletionRun {
    readonly expiredEnqueued: number;
    readonly claimed: number;
    readonly scheduled: number;
    readonly deferred: number;
}
/**
 * Claims and delivers the volume deletion outbox. Claims have leases so a
 * crashed worker is recoverable; each object is finalized independently so a
 * poison row cannot prevent later rows in the same batch from being attempted.
 */
export declare class VolumeDeletionWorker {
    #private;
    private readonly storage;
    private readonly now;
    constructor(repository: VolumeRepository | Database, storage: VolumeObjectStore, now?: () => Date);
    run(limit?: number): Promise<VolumeDeletionRun>;
}
