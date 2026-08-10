import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Queryable } from '../db/client.js';
import { apiKeyPublicPrefix } from './api-key.js';

const bucketSlots = 1 << 20;
const maximumStoredCount = 1_000_001;

export interface ApiRateLimitConfig {
	readonly enabled: boolean;
	readonly windowSeconds: number;
	readonly preAuthIpRequests: number;
	readonly preAuthApiKeyRequests: number;
	readonly principalRequests: number;
	readonly organizationRequests: number;
	readonly projectRequests: number;
	readonly failClosed: boolean;
}

export interface AdmissionIdentity {
	readonly principalId: string;
	readonly organizationId?: string;
	readonly projectId?: string;
}

export interface ApiAdmission {
	preAuthenticate(request: Request, token?: string): Promise<void>;
	authenticate(identity: AdmissionIdentity): Promise<void>;
}

export class ApiRateLimitExceeded extends Error {
	readonly code = 'rate_limit_exceeded';

	constructor(readonly retryAfterSeconds: number) {
		super('The API request rate limit has been reached.');
	}
}

export class ApiAdmissionUnavailable extends Error {
	readonly code = 'api_admission_unavailable';

	constructor() {
		super('API admission could not be verified.');
	}
}

type AdmissionScope =
	| 'preauth_ip'
	| 'preauth_api_key'
	| 'preauth_credential'
	| 'principal'
	| 'organization'
	| 'project';

interface AdmissionBucket {
	readonly scope: AdmissionScope;
	readonly identifier: string;
	readonly limit: number;
}

interface AdmissionRow {
	readonly allowed: boolean;
	readonly retry_after_seconds: number | string;
}

const ipv4Network = (address: string): string | undefined => {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!match) return undefined;
	const octets = match.slice(1).map(Number);
	if (octets.some((octet) => octet > 255)) return undefined;
	return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
};

const ipv6Bytes = (address: string): Uint8Array | undefined => {
	if (address.includes('%') || address.split('::').length > 2) return undefined;
	const halves = address.toLowerCase().split('::');
	const parseHalf = (half: string): number[] | undefined => {
		if (!half) return [];
		const words: number[] = [];
		for (const part of half.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
			words.push(Number.parseInt(part, 16));
		}
		return words;
	};
	const left = parseHalf(halves[0] ?? '');
	const right = parseHalf(halves[1] ?? '');
	if (!left || !right) return undefined;
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
		return undefined;
	}
	const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
	if (words.length !== 8) return undefined;
	const bytes = new Uint8Array(16);
	words.forEach((word, index) => {
		bytes[index * 2] = word >>> 8;
		bytes[index * 2 + 1] = word & 0xff;
	});
	return bytes;
};

/**
 * Collapse public addresses to /24 (IPv4) or /56 (IPv6). The source header is
 * installed by main.ts only after direct-socket or gateway-HMAC validation.
 */
export const coarseClientIdentity = (raw: string | null): string => {
	const address = (raw ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
	if (isIP(address) === 4) return `ipv4:${ipv4Network(address) ?? 'invalid'}`;
	if (isIP(address) === 6) {
		const bytes = ipv6Bytes(address);
		if (bytes) return `ipv6:${Buffer.from(bytes.slice(0, 7)).toString('hex')}/56`;
	}
	return 'unknown';
};

const slotFor = (scope: AdmissionScope, identifier: string): number =>
	createHash('sha256').update(scope).update('\0').update(identifier).digest().readUInt32BE(0) &
	(bucketSlots - 1);

export class PostgresApiAdmission implements ApiAdmission {
	constructor(
		private readonly database: Queryable,
		private readonly config: ApiRateLimitConfig
	) {}

	async preAuthenticate(request: Request, token?: string): Promise<void> {
		const source = coarseClientIdentity(request.headers.get('x-nehemiah-client-address'));
		const buckets: AdmissionBucket[] = [
			{
				scope: 'preauth_ip',
				identifier: source,
				limit: this.config.preAuthIpRequests
			}
		];
		if (token) {
			buckets.push({
				scope: 'preauth_credential',
				// The presented credential has at least 256 bits of secret material for
				// API/device tokens. Only the separately hashed 20-bit slot reaches PG.
				// This source-independent bucket bounds a stolen valid key before Argon2.
				identifier: createHash('sha256')
					.update('nehemiah-preauth-credential-v1\0')
					.update(token)
					.digest('hex'),
				limit: this.config.preAuthApiKeyRequests
			});
			const prefix = apiKeyPublicPrefix(token);
			if (prefix) {
				buckets.push({
					scope: 'preauth_api_key',
					// Pairing the public prefix with a trusted coarse source prevents
					// someone who merely sees a prefix from globally denying its owner.
					identifier: `${source}\0${prefix}`,
					limit: this.config.preAuthApiKeyRequests
				});
			}
		}
		await this.consume(buckets);
	}

	async authenticate(identity: AdmissionIdentity): Promise<void> {
		const buckets: AdmissionBucket[] = [
			{
				scope: 'principal',
				identifier: identity.principalId,
				limit: this.config.principalRequests
			}
		];
		if (identity.organizationId) {
			buckets.push({
				scope: 'organization',
				identifier: identity.organizationId,
				limit: this.config.organizationRequests
			});
		}
		if (identity.projectId) {
			buckets.push({
				scope: 'project',
				identifier: identity.projectId,
				limit: this.config.projectRequests
			});
		}
		await this.consume(buckets);
	}

	private async consume(buckets: ReadonlyArray<AdmissionBucket>): Promise<void> {
		if (!this.config.enabled) return;
		const ordered = [...buckets].sort(
			(left, right) =>
				left.scope.localeCompare(right.scope) || left.identifier.localeCompare(right.identifier)
		);
		try {
			const result = await this.database.query<AdmissionRow>(
				`WITH requested(scope, bucket_slot, request_limit) AS (
				   SELECT * FROM unnest($1::text[], $2::integer[], $3::integer[])
				 ), current_window(window_started_at) AS (
				   SELECT to_timestamp(
				     floor(extract(epoch FROM statement_timestamp()) / $4::integer) * $4::integer
				   )
				 ), applied AS (
				   INSERT INTO api_admission_windows
				     (scope, bucket_slot, window_started_at, request_count)
				   SELECT scope, bucket_slot, window_started_at, 1
				   FROM requested CROSS JOIN current_window
				   ORDER BY scope, bucket_slot
				   ON CONFLICT (scope, bucket_slot) DO UPDATE SET
				     window_started_at = GREATEST(
				       api_admission_windows.window_started_at,
				       EXCLUDED.window_started_at
				     ),
				     request_count = CASE
				       WHEN EXCLUDED.window_started_at > api_admission_windows.window_started_at THEN 1
				       ELSE LEAST(api_admission_windows.request_count + 1, $5::integer)
				     END
				   RETURNING scope, bucket_slot, window_started_at, request_count
				 )
				 SELECT bool_and(applied.request_count <= requested.request_limit) AS allowed,
				        COALESCE(
				          max(GREATEST(1, ceil(extract(epoch FROM (
				            applied.window_started_at + make_interval(secs => $4::integer)
				            - statement_timestamp()
				          ))))) FILTER (WHERE applied.request_count > requested.request_limit),
				          1
				        )::integer AS retry_after_seconds
				 FROM applied
				 JOIN requested USING (scope, bucket_slot)`,
				[
					ordered.map(({ scope }) => scope),
					ordered.map(({ scope, identifier }) => slotFor(scope, identifier)),
					ordered.map(({ limit }) => limit),
					this.config.windowSeconds,
					maximumStoredCount
				]
			);
			const row = result.rows[0];
			if (!row?.allowed) {
				const retryAfter = Number(row?.retry_after_seconds ?? 1);
				throw new ApiRateLimitExceeded(
					Number.isSafeInteger(retryAfter) && retryAfter > 0
						? Math.min(retryAfter, this.config.windowSeconds)
						: 1
				);
			}
		} catch (error) {
			if (error instanceof ApiRateLimitExceeded) throw error;
			if (this.config.failClosed) throw new ApiAdmissionUnavailable();
		}
	}
}
