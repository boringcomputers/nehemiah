import { createHash, randomBytes } from 'node:crypto';
import { BillingAdmissionPolicy } from '../billing/admission.js';
import { Database } from '../db/client.js';

const mebibyte = 1_048_576;
const maximumVolumeBytes = 1_099_511_627_776; // 1 TiB.
export const defaultVolumeSizeLimitMb = 10_240;
export const defaultVolumeTtlSeconds = 30 * 24 * 60 * 60;
export const maximumVolumeTtlSeconds = 365 * 24 * 60 * 60;
export const volumeDeletionRetentionSeconds = 7 * 24 * 60 * 60;
export const defaultVolumeGrantTtlSeconds = 300;
export const maximumVolumeGrantTtlSeconds = 900;

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
	}): Promise<{ readonly observedSizeBytes: number }>;
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
	admitCreate(
		volume: Volume,
		idempotencyKey: string,
		requestHash: string
	): Promise<{ readonly volume: Volume; readonly replayed: boolean }>;
	list(organizationId: string, projectId: string | undefined, now: Date): Promise<Volume[]>;
	find(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		now: Date
	): Promise<Volume | undefined>;
	findForDeletion(
		id: string,
		organizationId: string,
		projectId?: string
	): Promise<Volume | undefined>;
	updateObservedSize(
		id: string,
		organizationId: string,
		observedSizeBytes: number
	): Promise<boolean>;
	reserveWriteGrant(input: {
		readonly id: string;
		readonly organizationId: string;
		readonly projectId?: string;
		readonly observedSizeBytes: number;
		readonly now: Date;
		readonly expiresAt: Date;
		readonly operationKey?: string;
	}): Promise<
		{ readonly volume: Volume; readonly reservation: VolumeWriteGrantReservation } | undefined
	>;
	markWriteGrantIssued(reservationId: string, organizationId: string, now: Date): Promise<boolean>;
	enqueueDeletion(input: {
		readonly id: string;
		readonly organizationId: string;
		readonly projectId?: string;
		readonly requestedAt: Date;
		readonly observedSizeBytes: number;
	}): Promise<{ readonly volume: Volume; readonly deleteAfter: Date } | undefined>;
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

type VolumeRow = {
	id: string;
	organization_id: string;
	project_id: string;
	object_prefix: string;
	size_limit_bytes: string;
	observed_size_bytes: string;
	created_at: Date;
	expires_at: Date;
	deleted_at: Date | null;
	idempotency_key: string | null;
	create_request_hash: string | null;
};

const fromRow = (row: VolumeRow): Volume => ({
	id: row.id,
	organizationId: row.organization_id,
	projectId: row.project_id,
	objectPrefix: row.object_prefix,
	sizeLimitBytes: Number(row.size_limit_bytes),
	observedSizeBytes: Number(row.observed_size_bytes),
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	deletedAt: row.deleted_at ?? undefined,
	idempotencyKey: row.idempotency_key ?? undefined,
	createRequestHash: row.create_request_hash ?? undefined
});

export class InvalidVolumeRequest extends Error {
	readonly code = 'invalid_volume_request';
}

export class VolumeProjectUnavailable extends Error {
	readonly code = 'volume_project_not_found';
}

export class VolumeQuotaExceeded extends Error {
	readonly code = 'storage_quota_exceeded';
}

export class VolumeIdempotencyConflict extends Error {
	readonly code = 'idempotency_conflict';
}

export class VolumeInfrastructureUnavailable extends Error {
	readonly code = 'volume_infrastructure_unavailable';
}

export class VolumeIntegrityError extends Error {
	readonly code = 'volume_integrity_failed';
}

export class PostgresVolumeRepository implements VolumeRepository {
	constructor(
		private readonly database: Database,
		private readonly billingAdmission = new BillingAdmissionPolicy()
	) {}

	async admitCreate(
		volume: Volume,
		idempotencyKey: string,
		requestHash: string
	): Promise<{ readonly volume: Volume; readonly replayed: boolean }> {
		return this.database.transaction(async (client) => {
			// Serialize allocation decisions per organization. Project locks alone
			// cannot enforce the aggregate organization allocation deterministically.
			const organization = await client.query<{ max_storage_mb: string }>(
				'SELECT max_storage_mb::text FROM organizations WHERE id = $1 FOR UPDATE',
				[volume.organizationId]
			);
			if (!organization.rows[0]) throw new VolumeProjectUnavailable('Project not found.');
			const project = await client.query<{ max_storage_mb: string }>(
				`SELECT max_storage_mb::text FROM projects
				 WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
				[volume.projectId, volume.organizationId]
			);
			if (!project.rows[0]) throw new VolumeProjectUnavailable('Project not found.');

			const existing = await client.query<VolumeRow>(
				`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
			        observed_size_bytes, created_at, expires_at, deleted_at,
			        idempotency_key, create_request_hash
			 FROM volumes
			 WHERE organization_id = $1 AND project_id = $2 AND idempotency_key = $3`,
				[volume.organizationId, volume.projectId, idempotencyKey]
			);
			if (existing.rows[0]) {
				if (existing.rows[0].create_request_hash !== requestHash) {
					throw new VolumeIdempotencyConflict(
						'Idempotency-Key was already used with a different volume request.'
					);
				}
				return { volume: fromRow(existing.rows[0]), replayed: true };
			}
			const commitmentSeconds = BigInt(
				Math.max(0, Math.ceil((volume.expiresAt.getTime() - volume.createdAt.getTime()) / 1_000))
			);
			await this.billingAdmission.enforce(client, volume.organizationId, {
				storageByteSeconds: BigInt(volume.sizeLimitBytes) * commitmentSeconds
			});

			const allocations = await client.query<{
				organization_allocated_bytes: string;
				project_allocated_bytes: string;
			}>(
				`SELECT
				   COALESCE(sum(size_limit_bytes) FILTER (
				     WHERE COALESCE(deleted_at, expires_at)
				             + ($4::bigint * interval '1 second') > $3
				        OR NOT EXISTS (
				          SELECT 1 FROM volume_deletion_jobs deletion
				          WHERE deletion.volume_id = volumes.id
				            AND deletion.scheduled_at IS NOT NULL
				        )
				   ), 0)::text AS organization_allocated_bytes,
				   COALESCE(sum(size_limit_bytes) FILTER (
				     WHERE project_id = $2
				       AND (
				         COALESCE(deleted_at, expires_at)
				           + ($4::bigint * interval '1 second') > $3
				         OR NOT EXISTS (
				           SELECT 1 FROM volume_deletion_jobs deletion
				           WHERE deletion.volume_id = volumes.id
				             AND deletion.scheduled_at IS NOT NULL
				         )
				       )
				   ), 0)::text AS project_allocated_bytes
				 FROM volumes WHERE organization_id = $1`,
				[volume.organizationId, volume.projectId, volume.createdAt, volumeDeletionRetentionSeconds]
			);
			const allocation = allocations.rows[0]!;
			const requested = BigInt(volume.sizeLimitBytes);
			const projectLimit = BigInt(project.rows[0].max_storage_mb) * BigInt(mebibyte);
			const organizationLimit = BigInt(organization.rows[0].max_storage_mb) * BigInt(mebibyte);
			if (
				BigInt(allocation.project_allocated_bytes) + requested > projectLimit ||
				BigInt(allocation.organization_allocated_bytes) + requested > organizationLimit
			) {
				throw new VolumeQuotaExceeded(
					'The storage allocation exceeds the project or organization quota.'
				);
			}

			await client.query(
				`INSERT INTO volumes
			 (id, organization_id, project_id, object_prefix, size_limit_bytes,
			  observed_size_bytes, created_at, expires_at, idempotency_key, create_request_hash)
			 VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9)`,
				[
					volume.id,
					volume.organizationId,
					volume.projectId,
					volume.objectPrefix,
					volume.sizeLimitBytes,
					volume.createdAt,
					volume.expiresAt,
					idempotencyKey,
					requestHash
				]
			);
			return {
				volume: { ...volume, idempotencyKey, createRequestHash: requestHash },
				replayed: false
			};
		});
	}

	async list(organizationId: string, projectId: string | undefined, now: Date): Promise<Volume[]> {
		const result = await this.database.query<VolumeRow>(
			`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
			        observed_size_bytes, created_at, expires_at, deleted_at,
			        idempotency_key, create_request_hash
			 FROM volumes WHERE organization_id = $1
			   AND ($2::uuid IS NULL OR project_id = $2)
			   AND deleted_at IS NULL AND expires_at > $3
			 ORDER BY created_at DESC, id`,
			[organizationId, projectId ?? null, now]
		);
		return result.rows.map(fromRow);
	}

	async find(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		now: Date
	): Promise<Volume | undefined> {
		const result = await this.database.query<VolumeRow>(
			`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
			        observed_size_bytes, created_at, expires_at, deleted_at,
			        idempotency_key, create_request_hash
			 FROM volumes WHERE id = $1 AND organization_id = $2
			   AND ($3::uuid IS NULL OR project_id = $3)
			   AND deleted_at IS NULL AND expires_at > $4`,
			[id, organizationId, projectId ?? null, now]
		);
		return result.rows[0] ? fromRow(result.rows[0]) : undefined;
	}

	async findForDeletion(
		id: string,
		organizationId: string,
		projectId?: string
	): Promise<Volume | undefined> {
		const result = await this.database.query<VolumeRow>(
			`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
			        observed_size_bytes, created_at, expires_at, deleted_at,
			        idempotency_key, create_request_hash
			 FROM volumes WHERE id = $1 AND organization_id = $2
			   AND ($3::uuid IS NULL OR project_id = $3)`,
			[id, organizationId, projectId ?? null]
		);
		return result.rows[0] ? fromRow(result.rows[0]) : undefined;
	}

	async updateObservedSize(
		id: string,
		organizationId: string,
		observedSizeBytes: number
	): Promise<boolean> {
		const result = await this.database.query(
			`UPDATE volumes SET observed_size_bytes = $3
			 WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
			[id, organizationId, observedSizeBytes]
		);
		return Boolean(result.rowCount);
	}

	async reserveWriteGrant(input: {
		readonly id: string;
		readonly organizationId: string;
		readonly projectId?: string;
		readonly observedSizeBytes: number;
		readonly now: Date;
		readonly expiresAt: Date;
		readonly operationKey?: string;
	}): Promise<
		{ readonly volume: Volume; readonly reservation: VolumeWriteGrantReservation } | undefined
	> {
		return this.database.transaction(async (client) => {
			const organization = await client.query(
				'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
				[input.organizationId]
			);
			if (!organization.rows[0]) return undefined;
			// Every writer and delete takes the volume row lock. This turns the
			// object-store observation plus all still-live capabilities into one
			// serial allocation decision.
			const locked = await client.query<VolumeRow>(
				`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
				        observed_size_bytes, created_at, expires_at, deleted_at,
				        idempotency_key, create_request_hash
				 FROM volumes WHERE id = $1 AND organization_id = $2
				   AND ($3::uuid IS NULL OR project_id = $3)
				 FOR UPDATE`,
				[input.id, input.organizationId, input.projectId ?? null]
			);
			const row = locked.rows[0];
			if (!row || row.deleted_at || row.expires_at <= input.now) return undefined;
			const volume = fromRow(row);
			if (
				!Number.isSafeInteger(input.observedSizeBytes) ||
				input.observedSizeBytes < 0 ||
				input.observedSizeBytes > volume.sizeLimitBytes
			) {
				throw new VolumeIntegrityError('Observed volume size exceeds its allocation.');
			}

			await client.query('UPDATE volumes SET observed_size_bytes = $2 WHERE id = $1', [
				input.id,
				input.observedSizeBytes
			]);
			const observedVolume = { ...volume, observedSizeBytes: input.observedSizeBytes };

			if (input.operationKey !== undefined) {
				const replay = await client.query<{
					id: string;
					maximum_bytes: string;
					expires_at: Date;
				}>(
					`SELECT id, maximum_bytes::text, expires_at
					 FROM volume_write_grant_reservations
					 WHERE volume_id = $1 AND operation_key = $2 AND expires_at > $3
					 ORDER BY attempt DESC LIMIT 1`,
					[input.id, input.operationKey, input.now]
				);
				if (replay.rows[0]) {
					return {
						volume: observedVolume,
						reservation: {
							id: replay.rows[0].id,
							volumeId: input.id,
							maximumBytes: Number(replay.rows[0].maximum_bytes),
							expiresAt: replay.rows[0].expires_at
						}
					};
				}
			}
			await this.billingAdmission.enforce(client, input.organizationId);

			const reserved = await client.query<{ outstanding_bytes: string }>(
				`SELECT COALESCE(sum(GREATEST(
				          maximum_bytes - GREATEST($2::bigint - observed_size_at_reservation, 0),
				          0
				        )), 0)::text AS outstanding_bytes
				 FROM volume_write_grant_reservations
				 WHERE volume_id = $1 AND expires_at > $3`,
				[input.id, input.observedSizeBytes, input.now]
			);
			const maximumBytes =
				BigInt(volume.sizeLimitBytes) -
				BigInt(input.observedSizeBytes) -
				BigInt(reserved.rows[0]!.outstanding_bytes);
			if (maximumBytes < 1n) {
				throw new VolumeQuotaExceeded(
					'The volume has no unreserved storage while another PUT grant is active.'
				);
			}
			const attempt = input.operationKey
				? await client.query<{ attempt: number }>(
						`SELECT COALESCE(max(attempt), 0)::integer + 1 AS attempt
						 FROM volume_write_grant_reservations
						 WHERE volume_id = $1 AND operation_key = $2`,
						[input.id, input.operationKey]
					)
				: undefined;
			const inserted = await client.query<{
				id: string;
				maximum_bytes: string;
				expires_at: Date;
			}>(
				`INSERT INTO volume_write_grant_reservations
				 (volume_id, organization_id, project_id, operation_key, attempt,
				  observed_size_at_reservation, maximum_bytes, created_at, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				 RETURNING id, maximum_bytes::text, expires_at`,
				[
					input.id,
					input.organizationId,
					volume.projectId,
					input.operationKey ?? null,
					attempt?.rows[0]?.attempt ?? 1,
					input.observedSizeBytes,
					maximumBytes.toString(),
					input.now,
					input.expiresAt
				]
			);
			return {
				volume: observedVolume,
				reservation: {
					id: inserted.rows[0]!.id,
					volumeId: input.id,
					maximumBytes: Number(inserted.rows[0]!.maximum_bytes),
					expiresAt: inserted.rows[0]!.expires_at
				}
			};
		});
	}

	async markWriteGrantIssued(
		reservationId: string,
		organizationId: string,
		now: Date
	): Promise<boolean> {
		return this.database.transaction(async (client) => {
			const reservation = await client.query<{ volume_id: string }>(
				`SELECT volume_id FROM volume_write_grant_reservations
				 WHERE id = $1 AND organization_id = $2`,
				[reservationId, organizationId]
			);
			if (!reservation.rows[0]) return false;
			const volume = await client.query<{ active: boolean }>(
				`SELECT deleted_at IS NULL AND expires_at > $3 AS active
				 FROM volumes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
				[reservation.rows[0].volume_id, organizationId, now]
			);
			if (!volume.rows[0]?.active) return false;
			const issued = await client.query(
				`UPDATE volume_write_grant_reservations
				 SET issued_at = COALESCE(issued_at, $3)
				 WHERE id = $1 AND organization_id = $2 AND expires_at > $3`,
				[reservationId, organizationId, now]
			);
			return Boolean(issued.rowCount);
		});
	}

	async enqueueDeletion(input: {
		readonly id: string;
		readonly organizationId: string;
		readonly projectId?: string;
		readonly requestedAt: Date;
		readonly observedSizeBytes: number;
	}): Promise<{ readonly volume: Volume; readonly deleteAfter: Date } | undefined> {
		return this.database.transaction(async (client) => {
			const locked = await client.query<VolumeRow>(
				`SELECT id, organization_id, project_id, object_prefix, size_limit_bytes,
				        observed_size_bytes, created_at, expires_at, deleted_at,
				        idempotency_key, create_request_hash
				 FROM volumes WHERE id = $1 AND organization_id = $2
				   AND ($3::uuid IS NULL OR project_id = $3)
				 FOR UPDATE`,
				[input.id, input.organizationId, input.projectId ?? null]
			);
			const existing = locked.rows[0];
			if (!existing) return undefined;
			let volume = fromRow(existing);
			if (!volume.deletedAt) {
				const updated = await client.query<VolumeRow>(
					`UPDATE volumes
					 SET deleted_at = $2, observed_size_bytes = $3
					 WHERE id = $1
					 RETURNING id, organization_id, project_id, object_prefix, size_limit_bytes,
					           observed_size_bytes, created_at, expires_at, deleted_at,
					           idempotency_key, create_request_hash`,
					[input.id, input.requestedAt, input.observedSizeBytes]
				);
				volume = fromRow(updated.rows[0]!);
			} else if (volume.observedSizeBytes !== input.observedSizeBytes) {
				const updated = await client.query<VolumeRow>(
					`UPDATE volumes
					 SET observed_size_bytes = $2
					 WHERE id = $1
					 RETURNING id, organization_id, project_id, object_prefix, size_limit_bytes,
					           observed_size_bytes, created_at, expires_at, deleted_at,
					           idempotency_key, create_request_hash`,
					[input.id, input.observedSizeBytes]
				);
				volume = fromRow(updated.rows[0]!);
			}
			const requestedAt = volume.deletedAt!;
			const deleteAfter = new Date(requestedAt.getTime() + volumeDeletionRetentionSeconds * 1_000);
			await client.query(
				`INSERT INTO volume_deletion_jobs
				 (volume_id, organization_id, project_id, delete_after, requested_at,
				  next_attempt_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $5, $5)
				 ON CONFLICT (volume_id) DO NOTHING`,
				[volume.id, volume.organizationId, volume.projectId, deleteAfter, requestedAt]
			);
			return { volume, deleteAfter };
		});
	}

	async enqueueExpiredDeletions(now: Date, limit: number): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error('volume deletion enqueue limit must be between 1 and 1000');
		}
		return this.database.transaction(async (client) => {
			const result = await client.query(
				`WITH expired AS (
				   SELECT id, expires_at
				   FROM volumes
				   WHERE deleted_at IS NULL AND expires_at <= $1
				   ORDER BY expires_at, id
				   LIMIT $2
				   FOR UPDATE SKIP LOCKED
				 ), marked AS (
				   UPDATE volumes volume
				   SET deleted_at = expired.expires_at,
				       observed_size_bytes = LEAST(volume.observed_size_bytes, volume.size_limit_bytes)
				   FROM expired
				   WHERE volume.id = expired.id
				   RETURNING volume.id, volume.organization_id, volume.project_id,
				             volume.deleted_at
				 )
				 INSERT INTO volume_deletion_jobs
				  (volume_id, organization_id, project_id, delete_after, requested_at,
				   next_attempt_at, updated_at)
					 SELECT id, organization_id, project_id,
					        deleted_at + ($3::bigint * interval '1 second'),
					        deleted_at, deleted_at, $1
				 FROM marked
				 ON CONFLICT (volume_id) DO NOTHING`,
				[now, limit, volumeDeletionRetentionSeconds]
			);
			return result.rowCount ?? 0;
		});
	}

	async claimDeletionJobs(input: {
		readonly now: Date;
		readonly limit: number;
		readonly claimToken: string;
		readonly claimTtlSeconds: number;
	}): Promise<VolumeDeletionJob[]> {
		if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
			throw new Error('volume deletion claim limit must be between 1 and 1000');
		}
		if (
			!Number.isSafeInteger(input.claimTtlSeconds) ||
			input.claimTtlSeconds < 1 ||
			input.claimTtlSeconds > 3_600
		) {
			throw new Error('volume deletion claim TTL must be between 1 and 3600 seconds');
		}
		const result = await this.database.query<
			VolumeRow & { delete_after: Date; attempt_count: number; claim_token: string }
		>(
			`WITH candidates AS (
			   SELECT volume_id
			   FROM volume_deletion_jobs
			   WHERE scheduled_at IS NULL
			     AND next_attempt_at <= $1
			     AND (claim_token IS NULL OR claim_expires_at <= $1)
			   ORDER BY next_attempt_at, requested_at, volume_id
			   LIMIT $2
			   FOR UPDATE SKIP LOCKED
			 ), claimed AS (
			   UPDATE volume_deletion_jobs job
			   SET claim_token = $3,
			       claimed_at = $1,
			       claim_expires_at = $1 + ($4::bigint * interval '1 second'),
			       attempt_count = attempt_count + 1,
			       updated_at = $1
			   FROM candidates
			   WHERE job.volume_id = candidates.volume_id
			   RETURNING job.volume_id, job.delete_after, job.attempt_count, job.claim_token
			 )
			 SELECT volume.id, volume.organization_id, volume.project_id,
			        volume.object_prefix, volume.size_limit_bytes, volume.observed_size_bytes,
			        volume.created_at, volume.expires_at, volume.deleted_at,
			        volume.idempotency_key, volume.create_request_hash,
			        claimed.delete_after, claimed.attempt_count, claimed.claim_token
			 FROM claimed
			 JOIN volumes volume ON volume.id = claimed.volume_id`,
			[input.now, input.limit, input.claimToken, input.claimTtlSeconds]
		);
		return result.rows.map((row) => ({
			volume: fromRow(row),
			deleteAfter: row.delete_after,
			attemptCount: row.attempt_count,
			claimToken: row.claim_token
		}));
	}

	async markDeletionScheduled(volumeId: string, scheduledAt: Date): Promise<boolean> {
		const result = await this.database.query(
			`UPDATE volume_deletion_jobs
			 SET scheduled_at = COALESCE(scheduled_at, GREATEST($2, requested_at)),
			     claim_token = NULL,
			     claimed_at = NULL,
			     claim_expires_at = NULL,
			     last_error_code = NULL,
			     updated_at = $2
			 WHERE volume_id = $1`,
			[volumeId, scheduledAt]
		);
		return Boolean(result.rowCount);
	}

	async deferDeletion(input: {
		readonly volumeId: string;
		readonly now: Date;
		readonly nextAttemptAt: Date;
		readonly claimToken?: string;
		readonly errorCode: string;
	}): Promise<boolean> {
		const result = await this.database.query(
			`UPDATE volume_deletion_jobs
			 SET next_attempt_at = GREATEST(next_attempt_at, $3),
			     attempt_count = attempt_count + CASE WHEN $4::uuid IS NULL THEN 1 ELSE 0 END,
			     claim_token = NULL,
			     claimed_at = NULL,
			     claim_expires_at = NULL,
			     last_error_code = $5,
			     updated_at = $2
			 WHERE volume_id = $1 AND scheduled_at IS NULL
			   AND ($4::uuid IS NULL OR claim_token = $4)`,
			[input.volumeId, input.now, input.nextAttemptAt, input.claimToken ?? null, input.errorCode]
		);
		return Boolean(result.rowCount);
	}
}

const validUuid = (value: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const validHeaders = (headers: Readonly<Record<string, string>> | undefined): boolean =>
	headers === undefined ||
	(Object.keys(headers).length <= 16 &&
		Object.entries(headers).every(
			([name, value]) =>
				/^[a-z0-9-]{1,128}$/i.test(name) &&
				typeof value === 'string' &&
				value.length <= 4_096 &&
				!/[\r\n]/.test(value) &&
				!['authorization', 'cookie', 'proxy-authorization', 'x-amz-security-token'].includes(
					name.toLowerCase()
				)
		));

const validateGrant = (
	grant: VolumeObjectGrant,
	expected: {
		readonly method: VolumeGrantMethod;
		readonly objectPrefix: string;
		readonly expiresAt: Date;
		readonly maximumBytes?: number;
	},
	now: Date
): void => {
	let url: URL;
	try {
		url = new URL(grant.url);
	} catch {
		throw new VolumeInfrastructureUnavailable('Object storage returned an invalid scoped grant.');
	}
	if (
		grant.method !== expected.method ||
		grant.objectPrefix !== expected.objectPrefix ||
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== '' ||
		grant.expiresAt <= now ||
		grant.expiresAt > expected.expiresAt ||
		grant.expiresAt.getTime() - now.getTime() > maximumVolumeGrantTtlSeconds * 1_000 ||
		!validHeaders(grant.headers) ||
		grant.encryptionAtRest !== true ||
		(expected.method === 'PUT' &&
			(!Number.isSafeInteger(grant.maximumBytes) ||
				grant.maximumBytes! <= 0 ||
				grant.maximumBytes! > (expected.maximumBytes ?? 0)))
	) {
		throw new VolumeInfrastructureUnavailable('Object storage returned an invalid scoped grant.');
	}
};

const infrastructure = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof VolumeInfrastructureUnavailable || error instanceof VolumeIntegrityError) {
			throw error;
		}
		throw new VolumeInfrastructureUnavailable('Durable volume storage is unavailable.');
	}
};

export class VolumeService {
	readonly #repository: VolumeRepository;

	constructor(
		repository: VolumeRepository | Database,
		private readonly storage?: VolumeObjectStore,
		private readonly now: () => Date = () => new Date()
	) {
		this.#repository =
			'transaction' in repository ? new PostgresVolumeRepository(repository) : repository;
	}

	async create(input: {
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
	}> {
		if (!validUuid(input.organizationId) || !validUuid(input.projectId)) {
			throw new InvalidVolumeRequest('organization_id and project_id must be UUIDs.');
		}
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
			throw new InvalidVolumeRequest('A valid Idempotency-Key header is required.');
		}
		const sizeLimitMb = input.sizeLimitMb ?? defaultVolumeSizeLimitMb;
		const ttlSeconds = input.ttlSeconds ?? defaultVolumeTtlSeconds;
		const grantTtlSeconds = input.grantTtlSeconds ?? defaultVolumeGrantTtlSeconds;
		if (
			!Number.isSafeInteger(sizeLimitMb) ||
			sizeLimitMb < 1 ||
			sizeLimitMb * mebibyte > maximumVolumeBytes
		) {
			throw new InvalidVolumeRequest('size_limit_mb must be an integer from 1 to 1048576.');
		}
		if (
			!Number.isSafeInteger(ttlSeconds) ||
			ttlSeconds < 3_600 ||
			ttlSeconds > maximumVolumeTtlSeconds
		) {
			throw new InvalidVolumeRequest('ttl_seconds must be an integer from 3600 to 31536000.');
		}
		this.#validateGrantTtl(grantTtlSeconds);
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					organizationId: input.organizationId,
					projectId: input.projectId,
					sizeLimitMb,
					ttlSeconds,
					grantTtlSeconds
				})
			)
			.digest('hex');
		// Adapter availability is checked before quota admission. A deployment
		// without durable object storage must never leave volume metadata behind.
		const storage = this.#storage();
		const createdAt = this.now();
		const id = `vol_${randomBytes(16).toString('base64url')}`;
		const objectPrefix = `organizations/${input.organizationId}/projects/${input.projectId}/volumes/${id}/`;
		const volume: Volume = {
			id,
			organizationId: input.organizationId,
			projectId: input.projectId,
			objectPrefix,
			sizeLimitBytes: sizeLimitMb * mebibyte,
			observedSizeBytes: 0,
			createdAt,
			expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1_000)
		};
		const admitted = await this.#repository.admitCreate(volume, input.idempotencyKey, requestHash);
		// Quota admission is durable before any upload capability is minted.
		// Replays reuse both the volume and its active reservation ID.
		const observedSizeBytes = await this.#inspect(storage, admitted.volume);
		const issued = await this.#issueWrite(
			storage,
			{ ...admitted.volume, observedSizeBytes },
			grantTtlSeconds,
			'create'
		);
		if (!issued) {
			throw new VolumeInfrastructureUnavailable(
				'The admitted volume became unavailable before grant issuance.'
			);
		}
		return { ...issued, replayed: admitted.replayed };
	}

	list(organizationId: string, projectId?: string): Promise<Volume[]> {
		return this.#repository.list(organizationId, projectId, this.now());
	}

	get(id: string, organizationId: string, projectId?: string): Promise<Volume | undefined> {
		return this.#repository.find(id, organizationId, projectId, this.now());
	}

	async grant(
		id: string,
		organizationId: string,
		projectId: string | undefined,
		method: VolumeGrantMethod,
		ttlSeconds?: number
	): Promise<{ readonly volume: Volume; readonly grant: VolumeObjectGrant } | undefined> {
		const volume = await this.get(id, organizationId, projectId);
		if (!volume) return undefined;
		const storage = this.#storage();
		const observedSizeBytes = await this.#inspect(storage, volume);
		if (method === 'PUT') {
			return this.#issueWrite(storage, { ...volume, observedSizeBytes }, ttlSeconds);
		}
		const observed = { ...volume, observedSizeBytes };
		const grant = await this.#issueRead(storage, observed, ttlSeconds);
		if (!(await this.#repository.updateObservedSize(id, organizationId, observedSizeBytes))) {
			// The only durable result is denial. A concurrent delete may have won
			// after the scoped grant was minted, so never return that grant.
			return undefined;
		}
		return { volume: observed, grant };
	}

	async remove(
		id: string,
		organizationId: string,
		projectId?: string
	): Promise<{ readonly volume: Volume; readonly deleteAfter: Date } | undefined> {
		const volume = await this.#repository.findForDeletion(id, organizationId, projectId);
		if (!volume) return undefined;
		const storage = this.#storage();
		const requestedAt = this.now();
		const observedSizeBytes = volume.deletedAt
			? this.#safeLastKnownObservation(volume)
			: await this.#inspectForDeletion(storage, volume);
		const deletion = await this.#repository.enqueueDeletion({
			id,
			organizationId,
			projectId,
			requestedAt,
			observedSizeBytes
		});
		if (!deletion) return undefined;
		// The PostgreSQL outbox is already durable and its next attempt is the
		// retention boundary. A brokered adapter intentionally does no external
		// work before then; quota remains allocated until the exact prefix is
		// actually deleted and the outbox is marked complete.
		if (storage.deletionMode === 'at-retention-boundary') {
			if (
				!(await this.#repository.deferDeletion({
					volumeId: id,
					now: this.now(),
					nextAttemptAt: deletion.deleteAfter,
					errorCode: 'volume_retention_pending'
				}))
			) {
				throw new VolumeInfrastructureUnavailable(
					'The durable volume retention request could not be finalized.'
				);
			}
			return deletion;
		}
		try {
			await storage.scheduleDeletion({
				organizationId: deletion.volume.organizationId,
				projectId: deletion.volume.projectId,
				objectPrefix: deletion.volume.objectPrefix,
				deleteAfter: deletion.deleteAfter
			});
			if (!(await this.#repository.markDeletionScheduled(id, this.now()))) {
				throw new VolumeInfrastructureUnavailable(
					'The durable volume deletion request could not be finalized.'
				);
			}
		} catch (error) {
			const failedAt = this.now();
			await this.#repository
				.deferDeletion({
					volumeId: id,
					now: failedAt,
					nextAttemptAt: new Date(failedAt.getTime() + 1_000),
					errorCode: 'volume_deletion_schedule_failed'
				})
				.catch(() => undefined);
			throw error instanceof VolumeInfrastructureUnavailable
				? error
				: new VolumeInfrastructureUnavailable('Durable volume storage is unavailable.');
		}
		return deletion;
	}

	#storage(): VolumeObjectStore {
		if (!this.storage) {
			throw new VolumeInfrastructureUnavailable(
				'Durable volume storage is not configured on this control plane.'
			);
		}
		return this.storage;
	}

	async #inspect(storage: VolumeObjectStore, volume: Volume): Promise<number> {
		const observation = await infrastructure(() =>
			storage.inspect({
				organizationId: volume.organizationId,
				projectId: volume.projectId,
				objectPrefix: volume.objectPrefix
			})
		);
		if (
			!Number.isSafeInteger(observation.observedSizeBytes) ||
			observation.observedSizeBytes < 0 ||
			observation.observedSizeBytes > volume.sizeLimitBytes
		) {
			throw new VolumeIntegrityError('Observed volume size exceeds its allocation.');
		}
		return observation.observedSizeBytes;
	}

	#safeLastKnownObservation(volume: Volume): number {
		return Number.isSafeInteger(volume.observedSizeBytes) && volume.observedSizeBytes >= 0
			? Math.min(volume.observedSizeBytes, volume.sizeLimitBytes)
			: 0;
	}

	async #inspectForDeletion(storage: VolumeObjectStore, volume: Volume): Promise<number> {
		try {
			const observation = await storage.inspect({
				organizationId: volume.organizationId,
				projectId: volume.projectId,
				objectPrefix: volume.objectPrefix
			});
			if (
				Number.isSafeInteger(observation.observedSizeBytes) &&
				observation.observedSizeBytes >= 0
			) {
				return Math.min(observation.observedSizeBytes, volume.sizeLimitBytes);
			}
		} catch {
			// Object inspection is advisory for deletion. The durable lifecycle
			// request must still be scheduled when an object is corrupt or unreadable.
		}
		return this.#safeLastKnownObservation(volume);
	}

	#validateGrantTtl(ttlSeconds: number): void {
		if (
			!Number.isSafeInteger(ttlSeconds) ||
			ttlSeconds < 1 ||
			ttlSeconds > maximumVolumeGrantTtlSeconds
		) {
			throw new InvalidVolumeRequest('grant_ttl_seconds must be an integer from 1 to 900.');
		}
	}

	#grantExpiry(volume: Volume, ttlSeconds: number, issuedAt: Date): Date {
		this.#validateGrantTtl(ttlSeconds);
		return new Date(Math.min(volume.expiresAt.getTime(), issuedAt.getTime() + ttlSeconds * 1_000));
	}

	async #issueRead(
		storage: VolumeObjectStore,
		volume: Volume,
		ttlSeconds = defaultVolumeGrantTtlSeconds
	): Promise<VolumeObjectGrant> {
		const issuedAt = this.now();
		const expiresAt = this.#grantExpiry(volume, ttlSeconds, issuedAt);
		const grant = await infrastructure(() =>
			storage.issueGrant({
				organizationId: volume.organizationId,
				projectId: volume.projectId,
				objectPrefix: volume.objectPrefix,
				method: 'GET',
				expiresAt,
				requireEncryptionAtRest: true
			})
		);
		validateGrant(grant, { method: 'GET', objectPrefix: volume.objectPrefix, expiresAt }, issuedAt);
		return grant;
	}

	async #issueWrite(
		storage: VolumeObjectStore,
		volume: Volume,
		ttlSeconds = defaultVolumeGrantTtlSeconds,
		operationKey?: string
	): Promise<{ readonly volume: Volume; readonly grant: VolumeObjectGrant } | undefined> {
		const issuedAt = this.now();
		const capabilityExpiresAt = this.#grantExpiry(volume, ttlSeconds, issuedAt);
		const settlementSeconds = storage.reservationSettlementSeconds ?? 0;
		if (
			!Number.isSafeInteger(settlementSeconds) ||
			settlementSeconds < 0 ||
			settlementSeconds > maximumVolumeGrantTtlSeconds
		) {
			throw new VolumeInfrastructureUnavailable(
				'Durable volume storage returned an invalid reservation settlement window.'
			);
		}
		const reservationExpiresAt = new Date(
			capabilityExpiresAt.getTime() + settlementSeconds * 1_000
		);
		const reserved = await this.#repository.reserveWriteGrant({
			id: volume.id,
			organizationId: volume.organizationId,
			projectId: volume.projectId,
			observedSizeBytes: volume.observedSizeBytes,
			now: issuedAt,
			expiresAt: reservationExpiresAt,
			operationKey
		});
		if (!reserved) return undefined;
		const grant = await infrastructure(() =>
			storage.issueGrant({
				organizationId: reserved.volume.organizationId,
				projectId: reserved.volume.projectId,
				objectPrefix: reserved.volume.objectPrefix,
				method: 'PUT',
				capabilityExpiresAt,
				expiresAt: reserved.reservation.expiresAt,
				maximumBytes: reserved.reservation.maximumBytes,
				requireEncryptionAtRest: true,
				reservationId: reserved.reservation.id
			})
		);
		validateGrant(
			grant,
			{
				method: 'PUT',
				objectPrefix: reserved.volume.objectPrefix,
				expiresAt: reserved.reservation.expiresAt,
				maximumBytes: reserved.reservation.maximumBytes
			},
			issuedAt
		);
		if (
			!(await this.#repository.markWriteGrantIssued(
				reserved.reservation.id,
				reserved.volume.organizationId,
				this.now()
			))
		) {
			// A delete or expiry won after the capability was minted. Never expose
			// that capability from the control plane.
			return undefined;
		}
		return { volume: reserved.volume, grant };
	}
}

export const volumeJson = (volume: Volume, deleteAfter?: Date) => ({
	id: volume.id,
	project_id: volume.projectId,
	created_at: volume.createdAt.toISOString(),
	expires_at: volume.expiresAt.toISOString(),
	quota_mb: volume.sizeLimitBytes / mebibyte,
	used_bytes: volume.observedSizeBytes,
	deleted_at: volume.deletedAt?.toISOString(),
	delete_after: deleteAfter?.toISOString()
});

export const volumeGrantJson = (grant: VolumeObjectGrant) => ({
	method: grant.method,
	url: grant.url,
	headers: grant.headers ?? {},
	expires_at: grant.expiresAt.toISOString(),
	maximum_bytes: grant.maximumBytes
});
