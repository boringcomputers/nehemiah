import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const authorityIdentity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

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

const defaultRequestRateConfig: StreamRequestRateConfig = {
	windowSeconds: 60,
	authorityRequests: 120,
	projectRequests: 3_000,
	organizationRequests: 12_000
};

const requestBucketSlots = 1 << 20;
const maximumStoredRequestCount = 1_000_001;

type StreamRequestScope = 'authority' | 'project' | 'organization';

const requestSlot = (scope: StreamRequestScope, identifier: string): number =>
	createHash('sha256').update(scope).update('\0').update(identifier).digest().readUInt32BE(0) &
	(requestBucketSlots - 1);

export class StreamAdmissionRejected extends Error {
	readonly code = 'stream_quota_exceeded';
}

export class StreamRequestRateExceeded extends Error {
	readonly code = 'stream_request_rate_exceeded';

	constructor(readonly retryAfterSeconds: number) {
		super('The capability request rate limit has been reached.');
	}
}

export class InvalidStreamAdmission extends Error {
	readonly code = 'invalid_stream_admission';
}

const validate = (request: StreamAdmissionRequest): void => {
	if (
		!uuid.test(request.id) ||
		!uuid.test(request.organizationId) ||
		!uuid.test(request.projectId)
	) {
		throw new InvalidStreamAdmission('stream and tenant identities must be UUIDs');
	}
	if (
		!identity.test(request.instanceId) ||
		!authorityIdentity.test(request.authorityId) ||
		!['machine_capability', 'volume_capability'].includes(request.authorityKind) ||
		!Number.isSafeInteger(request.bandwidthBytesPerSecond) ||
		request.bandwidthBytesPerSecond < 1 ||
		request.bandwidthBytesPerSecond > 1_073_741_824
	) {
		throw new InvalidStreamAdmission('stream admission fields are invalid');
	}
};

/**
 * PostgreSQL is the global stream authority shared by every gateway and object
 * broker replica. The organization row is always locked before the project row,
 * matching other admission paths and serializing both quota dimensions.
 */
export class StreamAdmissionService {
	static readonly leaseSeconds = 15;

	constructor(
		private readonly database: Database,
		private readonly requestRate: StreamRequestRateConfig = defaultRequestRateConfig
	) {
		if (
			!Number.isSafeInteger(requestRate.windowSeconds) ||
			requestRate.windowSeconds < 10 ||
			requestRate.windowSeconds > 3_600 ||
			[
				requestRate.authorityRequests,
				requestRate.projectRequests,
				requestRate.organizationRequests
			].some((limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000)
		) {
			throw new InvalidStreamAdmission('stream request rate configuration is invalid');
		}
	}

	/**
	 * Consume global request admission before an exact capability route lookup.
	 * Revalidation of an exact, unexpired durable stream lease is free; all new
	 * stream identities consume simultaneous capability, project, and organization
	 * windows. Hash collisions only deny extra work and can never grant capacity.
	 */
	async admitRouteRequest(request: StreamAdmissionRequest): Promise<void> {
		validate(request);
		const scopes: ReadonlyArray<{
			readonly scope: StreamRequestScope;
			readonly identifier: string;
			readonly limit: number;
		}> = [
			{
				scope: 'authority',
				identifier: `${request.organizationId}\0${request.authorityKind}\0${request.authorityId}`,
				limit: this.requestRate.authorityRequests
			},
			{
				scope: 'project',
				identifier: `${request.organizationId}\0${request.projectId}`,
				limit: this.requestRate.projectRequests
			},
			{
				scope: 'organization',
				identifier: request.organizationId,
				limit: this.requestRate.organizationRequests
			}
		];
		const result = await this.database.query<{
			allowed: boolean;
			retry_after_seconds: number | string;
		}>(
			`WITH exact_active_lease AS (
			   SELECT 1 FROM gateway_stream_leases
			   WHERE id = $1 AND organization_id = $2 AND project_id = $3
			     AND authority_kind = $4 AND authority_id = $5
			     AND gateway_instance_id = $6
			     AND bandwidth_bytes_per_second = $7
			     AND expires_at > statement_timestamp()
			 ), requested(scope, bucket_slot, request_limit) AS (
			   SELECT * FROM unnest($8::text[], $9::integer[], $10::integer[])
			 ), current_window(window_started_at) AS (
			   SELECT to_timestamp(
			     floor(extract(epoch FROM statement_timestamp()) / $11::integer) * $11::integer
			   )
			 ), applied AS (
			   INSERT INTO gateway_capability_request_windows
			     (scope, bucket_slot, window_started_at, request_count)
			   SELECT scope, bucket_slot, window_started_at, 1
			   FROM requested CROSS JOIN current_window
			   WHERE NOT EXISTS (SELECT 1 FROM exact_active_lease)
			   ORDER BY scope, bucket_slot
			   ON CONFLICT (scope, bucket_slot) DO UPDATE SET
			     window_started_at = GREATEST(
			       gateway_capability_request_windows.window_started_at,
			       EXCLUDED.window_started_at
			     ),
			     request_count = CASE
			       WHEN EXCLUDED.window_started_at >
			            gateway_capability_request_windows.window_started_at THEN 1
			       ELSE LEAST(
			         gateway_capability_request_windows.request_count + 1,
			         $12::integer
			       )
			     END
			   RETURNING scope, bucket_slot, window_started_at, request_count
			 )
			 SELECT
			   COALESCE(bool_and(applied.request_count <= requested.request_limit), true) AS allowed,
			   COALESCE(
			     max(GREATEST(1, ceil(extract(epoch FROM (
			       applied.window_started_at + make_interval(secs => $11::integer)
			       - statement_timestamp()
			     ))))) FILTER (WHERE applied.request_count > requested.request_limit),
			     1
			   )::integer AS retry_after_seconds
			 FROM applied JOIN requested USING (scope, bucket_slot)`,
			[
				request.id,
				request.organizationId,
				request.projectId,
				request.authorityKind,
				request.authorityId,
				request.instanceId,
				request.bandwidthBytesPerSecond,
				scopes.map(({ scope }) => scope),
				scopes.map(({ scope, identifier }) => requestSlot(scope, identifier)),
				scopes.map(({ limit }) => limit),
				this.requestRate.windowSeconds,
				maximumStoredRequestCount
			]
		);
		const row = result.rows[0];
		if (!row?.allowed) {
			const retryAfter = Number(row?.retry_after_seconds ?? 1);
			throw new StreamRequestRateExceeded(
				Number.isSafeInteger(retryAfter) && retryAfter > 0
					? Math.min(retryAfter, this.requestRate.windowSeconds)
					: 1
			);
		}
	}

	async acquire(request: StreamAdmissionRequest): Promise<StreamLease> {
		validate(request);
		return this.database.transaction(async (client) => {
			const organization = await client.query<{
				max_gateway_streams: number;
				max_gateway_bandwidth_bps: string;
			}>(
				`SELECT max_gateway_streams, max_gateway_bandwidth_bps::text
				 FROM organizations WHERE id = $1 FOR UPDATE`,
				[request.organizationId]
			);
			const project = await client.query<{
				max_gateway_streams: number;
				max_gateway_bandwidth_bps: string;
			}>(
				`SELECT max_gateway_streams, max_gateway_bandwidth_bps::text
				 FROM projects WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
				[request.projectId, request.organizationId]
			);
			const organizationLimit = organization.rows[0];
			const projectLimit = project.rows[0];
			if (!organizationLimit || !projectLimit) {
				throw new InvalidStreamAdmission('stream tenant does not exist');
			}

			await client.query(
				`DELETE FROM gateway_stream_leases
				 WHERE organization_id = $1 AND expires_at <= statement_timestamp()`,
				[request.organizationId]
			);
			const existing = await client.query<{
				organization_id: string;
				project_id: string;
				authority_kind: StreamAuthorityKind;
				authority_id: string;
				gateway_instance_id: string;
				bandwidth_bytes_per_second: string;
			}>(
				`SELECT organization_id::text, project_id::text, authority_kind, authority_id,
				        gateway_instance_id, bandwidth_bytes_per_second::text
				 FROM gateway_stream_leases WHERE id = $1 FOR UPDATE`,
				[request.id]
			);
			const current = existing.rows[0];
			if (current) {
				if (
					current.organization_id !== request.organizationId ||
					current.project_id !== request.projectId ||
					current.authority_kind !== request.authorityKind ||
					current.authority_id !== request.authorityId ||
					current.gateway_instance_id !== request.instanceId ||
					Number(current.bandwidth_bytes_per_second) !== request.bandwidthBytesPerSecond
				) {
					throw new InvalidStreamAdmission('stream id was replayed with a different identity');
				}
			}

			const usage = await client.query<{
				organization_streams: number;
				organization_bandwidth: string;
				project_streams: number;
				project_bandwidth: string;
			}>(
				`SELECT
				   count(*)::integer AS organization_streams,
				   COALESCE(sum(bandwidth_bytes_per_second), 0)::text AS organization_bandwidth,
				   count(*) FILTER (WHERE project_id = $2)::integer AS project_streams,
				   COALESCE(sum(bandwidth_bytes_per_second)
				     FILTER (WHERE project_id = $2), 0)::text AS project_bandwidth
				 FROM gateway_stream_leases
				 WHERE organization_id = $1 AND expires_at > statement_timestamp()`,
				[request.organizationId, request.projectId]
			);
			const consumed = usage.rows[0]!;
			const additionalStreams = current ? 0 : 1;
			const additionalBandwidth = current ? 0 : request.bandwidthBytesPerSecond;
			if (
				consumed.organization_streams + additionalStreams > organizationLimit.max_gateway_streams ||
				consumed.project_streams + additionalStreams > projectLimit.max_gateway_streams ||
				BigInt(consumed.organization_bandwidth) + BigInt(additionalBandwidth) >
					BigInt(organizationLimit.max_gateway_bandwidth_bps) ||
				BigInt(consumed.project_bandwidth) + BigInt(additionalBandwidth) >
					BigInt(projectLimit.max_gateway_bandwidth_bps)
			) {
				throw new StreamAdmissionRejected('The organization or project stream quota is exhausted.');
			}

			const result = await client.query<{
				id: string;
				bandwidth_bytes_per_second: string;
				expires_at: Date;
			}>(
				`INSERT INTO gateway_stream_leases
				 (id, organization_id, project_id, authority_kind, authority_id,
				  gateway_instance_id, bandwidth_bytes_per_second, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7,
				         statement_timestamp() + ($8 * interval '1 second'))
				 ON CONFLICT (id) DO UPDATE
				 SET heartbeat_at = statement_timestamp(),
				     expires_at = statement_timestamp() + ($8 * interval '1 second')
				 WHERE gateway_stream_leases.organization_id = EXCLUDED.organization_id
				   AND gateway_stream_leases.project_id = EXCLUDED.project_id
				   AND gateway_stream_leases.authority_kind = EXCLUDED.authority_kind
				   AND gateway_stream_leases.authority_id = EXCLUDED.authority_id
				   AND gateway_stream_leases.gateway_instance_id = EXCLUDED.gateway_instance_id
				   AND gateway_stream_leases.bandwidth_bytes_per_second =
				       EXCLUDED.bandwidth_bytes_per_second
				 RETURNING id, bandwidth_bytes_per_second::text, expires_at`,
				[
					request.id,
					request.organizationId,
					request.projectId,
					request.authorityKind,
					request.authorityId,
					request.instanceId,
					request.bandwidthBytesPerSecond,
					StreamAdmissionService.leaseSeconds
				]
			);
			const persisted = result.rows[0];
			if (!persisted) {
				throw new InvalidStreamAdmission('stream id was replayed with a different identity');
			}
			return {
				id: persisted.id,
				bandwidthBytesPerSecond: Number(persisted.bandwidth_bytes_per_second),
				expiresAt: persisted.expires_at
			};
		});
	}

	async release(id: string, instanceId: string): Promise<void> {
		if (!uuid.test(id) || !identity.test(instanceId)) {
			throw new InvalidStreamAdmission('stream release identity is invalid');
		}
		await this.database.query(
			'DELETE FROM gateway_stream_leases WHERE id = $1 AND gateway_instance_id = $2',
			[id, instanceId]
		);
	}

	async reapExpired(limit = 1_000): Promise<number> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
			throw new InvalidStreamAdmission('stream reap limit is invalid');
		}
		const result = await this.database.query(
			`DELETE FROM gateway_stream_leases WHERE id IN (
			   SELECT id FROM gateway_stream_leases
			   WHERE expires_at <= statement_timestamp()
			   ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
			 )`,
			[limit]
		);
		return result.rowCount ?? 0;
	}
}
