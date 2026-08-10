import { randomUUID } from 'node:crypto';
import { PostgresVolumeRepository } from '../domain/volumes.js';
export const volumeDeletionClaimTtlSeconds = 60;
export const volumeDeletionBatchSize = 100;
export const volumeDeletionRetryDelayMs = (attemptCount) => Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 12));
/**
 * Claims and delivers the volume deletion outbox. Claims have leases so a
 * crashed worker is recoverable; each object is finalized independently so a
 * poison row cannot prevent later rows in the same batch from being attempted.
 */
export class VolumeDeletionWorker {
    storage;
    now;
    #repository;
    constructor(repository, storage, now = () => new Date()) {
        this.storage = storage;
        this.now = now;
        this.#repository =
            'transaction' in repository ? new PostgresVolumeRepository(repository) : repository;
    }
    async run(limit = volumeDeletionBatchSize) {
        const startedAt = this.now();
        const expiredEnqueued = await this.#repository.enqueueExpiredDeletions(startedAt, limit);
        const claims = await this.#repository.claimDeletionJobs({
            now: startedAt,
            limit,
            claimToken: randomUUID(),
            claimTtlSeconds: volumeDeletionClaimTtlSeconds
        });
        const results = await Promise.allSettled(claims.map((job) => this.#deliver(job)));
        const deliveryErrors = results
            .filter((result) => result.status === 'rejected')
            .map(({ reason }) => reason);
        if (deliveryErrors.length) {
            throw new AggregateError(deliveryErrors, 'one or more volume deletion jobs could not advance');
        }
        return {
            expiredEnqueued,
            claimed: claims.length,
            scheduled: results.filter((result) => result.status === 'fulfilled' && result.value === 'scheduled').length,
            deferred: results.filter((result) => result.status === 'fulfilled' && result.value === 'deferred').length
        };
    }
    async #deliver(job) {
        const deliveryStartedAt = this.now();
        if (this.storage.deletionMode === 'at-retention-boundary' &&
            job.deleteAfter > deliveryStartedAt) {
            const deferred = await this.#repository.deferDeletion({
                volumeId: job.volume.id,
                now: deliveryStartedAt,
                nextAttemptAt: job.deleteAfter,
                claimToken: job.claimToken,
                errorCode: 'volume_retention_pending'
            });
            if (!deferred)
                throw new Error('volume retention claim disappeared before deferral');
            return 'deferred';
        }
        try {
            await this.storage.scheduleDeletion({
                organizationId: job.volume.organizationId,
                projectId: job.volume.projectId,
                objectPrefix: job.volume.objectPrefix,
                deleteAfter: job.deleteAfter
            });
            if (!(await this.#repository.markDeletionScheduled(job.volume.id, this.now()))) {
                throw new Error('volume deletion job disappeared before completion');
            }
            return 'scheduled';
        }
        catch {
            const failedAt = this.now();
            const deferred = await this.#repository.deferDeletion({
                volumeId: job.volume.id,
                now: failedAt,
                nextAttemptAt: new Date(failedAt.getTime() + volumeDeletionRetryDelayMs(job.attemptCount)),
                claimToken: job.claimToken,
                errorCode: 'volume_deletion_schedule_failed'
            });
            if (!deferred)
                throw new Error('volume deletion claim disappeared before deferral');
            return 'deferred';
        }
    }
}
//# sourceMappingURL=schedule-volume-deletions.js.map