import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectVersionsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type HeadObjectCommandOutput,
	type ListObjectsV2CommandOutput,
	type PutObjectCommandOutput
} from '@aws-sdk/client-s3';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type {
	VolumeObjectGrant,
	VolumeObjectStore,
	VolumeGrantMethod
} from '../../domain/volumes.js';

const capabilityHeader = 'x-nehemiah-volume-capability';
const checksumHeader = 'x-nehemiah-content-sha256';
const capabilityIssuer = 'nehemiah-volume-broker';
const capabilityAudience = 'nehemiah-volume-object';
const maximumGrantTtlSeconds = 15 * 60;
const maximumSinglePutBytes = 5 * 1_024 * 1_024 * 1_024;
const maximumVolumeBytes = 1_099_511_627_776;
const reservationSettlementSeconds = 60;
const maximumDeletePasses = 1_024;
const headConcurrency = 16;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'i');
const checksumPattern = /^sha256:([0-9a-f]{64})$/;
const capabilityIdPattern = /^[A-Za-z0-9_-]{43}$/;

export interface S3VolumeObjectStoreConfig {
	readonly endpoint: string;
	readonly region: string;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
	readonly forcePathStyle?: boolean;
	readonly brokerPublicUrl: string;
	/** A base64-encoded 32-byte HS256 key, separate from every storage credential. */
	readonly brokerSecret: string;
}

type StorageCommand =
	| DeleteObjectCommand
	| DeleteObjectsCommand
	| GetObjectCommand
	| HeadObjectCommand
	| ListObjectVersionsCommand
	| ListObjectsV2Command
	| PutObjectCommand;

export interface S3VolumeObjectStoreDependencies {
	readonly now?: () => Date;
	readonly send?: (
		command: StorageCommand,
		options?: { readonly abortSignal?: AbortSignal }
	) => Promise<unknown>;
}

export class S3VolumeObjectStoreContractError extends Error {}

interface Revision {
	readonly key: string;
	readonly sizeBytes: number;
	readonly checksumHex: string;
	readonly lastModified: Date;
}

interface VolumeCapability extends JWTPayload {
	readonly method: VolumeGrantMethod;
	readonly organization_id: string;
	readonly project_id: string;
	readonly object_prefix: string;
	readonly object_key: string;
	readonly maximum_bytes?: number;
	readonly size_bytes?: number;
	readonly checksum_sha256?: string;
	readonly reservation_id?: string;
	readonly empty?: true;
}

interface VerifiedCapability {
	readonly method: VolumeGrantMethod;
	readonly organizationId: string;
	readonly projectId: string;
	readonly objectPrefix: string;
	readonly objectKey: string;
	readonly maximumBytes?: number;
	readonly sizeBytes?: number;
	readonly checksumHex?: string;
	readonly reservationId?: string;
	readonly empty: boolean;
	readonly expiresAt: Date;
}

const validEndpoint = (value: string): URL => {
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new S3VolumeObjectStoreContractError('S3 endpoint must be an origin-only HTTPS URL.');
	}
	if (
		endpoint.protocol !== 'https:' ||
		endpoint.username ||
		endpoint.password ||
		endpoint.pathname !== '/' ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new S3VolumeObjectStoreContractError('S3 endpoint must be an origin-only HTTPS URL.');
	}
	return endpoint;
};

const validBrokerUrl = (value: string): URL => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new S3VolumeObjectStoreContractError(
			'Volume broker public URL must be an origin-only HTTPS URL.'
		);
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new S3VolumeObjectStoreContractError(
			'Volume broker public URL must be an origin-only HTTPS URL.'
		);
	}
	return url;
};

const validStorageConfig = (config: S3VolumeObjectStoreConfig): void => {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(config.region)) {
		throw new S3VolumeObjectStoreContractError('S3 region is invalid.');
	}
	if (
		!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
		config.bucket.includes('..') ||
		config.bucket.includes('.-') ||
		config.bucket.includes('-.') ||
		/^\d{1,3}(?:\.\d{1,3}){3}$/.test(config.bucket)
	) {
		throw new S3VolumeObjectStoreContractError('S3 bucket is invalid.');
	}
	if (
		!config.accessKeyId ||
		config.accessKeyId.length > 256 ||
		/\s|[\u0000-\u001f\u007f]/.test(config.accessKeyId) ||
		config.secretAccessKey.length < 8 ||
		config.secretAccessKey.length > 256 ||
		/[\u0000-\u001f\u007f]/.test(config.secretAccessKey) ||
		(config.sessionToken !== undefined &&
			(!config.sessionToken ||
				config.sessionToken.length > 4_096 ||
				/[\u0000-\u001f\u007f]/.test(config.sessionToken)))
	) {
		throw new S3VolumeObjectStoreContractError('S3 credentials are invalid.');
	}
};

const capabilityKey = (encoded: string): Uint8Array => {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
		throw new S3VolumeObjectStoreContractError(
			'Volume broker secret must be a base64-encoded 32-byte key.'
		);
	}
	const decoded = Buffer.from(encoded, 'base64');
	if (decoded.byteLength !== 32 || decoded.toString('base64') !== encoded) {
		throw new S3VolumeObjectStoreContractError(
			'Volume broker secret must be a base64-encoded 32-byte key.'
		);
	}
	return decoded;
};

const volumePrefix = (organizationId: string, projectId: string, objectPrefix: string): string => {
	if (!uuidPattern.test(organizationId) || !uuidPattern.test(projectId)) {
		throw new S3VolumeObjectStoreContractError('Volume tenant identifiers are invalid.');
	}
	const expectedStart = `organizations/${organizationId}/projects/${projectId}/volumes/`;
	const volumeId = objectPrefix.startsWith(expectedStart)
		? objectPrefix.slice(expectedStart.length, -1)
		: '';
	if (
		!objectPrefix.endsWith('/') ||
		!/^(?:vol_)?[A-Za-z0-9_-]{16,128}$/.test(volumeId) ||
		objectPrefix !== `${expectedStart}${volumeId}/` ||
		Buffer.byteLength(objectPrefix, 'utf8') > 1_024
	) {
		throw new S3VolumeObjectStoreContractError(
			'Volume object prefix is outside the managed tenant namespace.'
		);
	}
	return objectPrefix;
};

const revisionPrefix = (objectPrefix: string): string => `${objectPrefix}revisions/`;
const revisionKey = (objectPrefix: string, reservationId: string): string => {
	if (!uuidPattern.test(reservationId)) {
		throw new S3VolumeObjectStoreContractError('Volume write reservation is invalid.');
	}
	return `${revisionPrefix(objectPrefix)}${reservationId.toLowerCase()}.bin`;
};

const validRevisionKey = (objectPrefix: string, key: string): boolean =>
	new RegExp(
		`^${revisionPrefix(objectPrefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${uuid}\\.bin$`,
		'i'
	).test(key);

const checksumHex = (encoded: string | undefined): string => {
	if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
		throw new S3VolumeObjectStoreContractError(
			'Stored volume revision is missing a full SHA-256 checksum.'
		);
	}
	const digest = Buffer.from(encoded, 'base64');
	if (digest.byteLength !== 32 || digest.toString('base64') !== encoded) {
		throw new S3VolumeObjectStoreContractError(
			'Stored volume revision has an invalid SHA-256 checksum.'
		);
	}
	return digest.toString('hex');
};

const isNotFound = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	(('name' in error && ['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(String(error.name))) ||
		('$metadata' in error &&
			typeof error.$metadata === 'object' &&
			error.$metadata !== null &&
			'httpStatusCode' in error.$metadata &&
			error.$metadata.httpStatusCode === 404));

const isPreconditionFailed = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	(('name' in error &&
		['PreconditionFailed', 'ConditionalRequestConflict'].includes(String(error.name))) ||
		('$metadata' in error &&
			typeof error.$metadata === 'object' &&
			error.$metadata !== null &&
			'httpStatusCode' in error.$metadata &&
			[409, 412].includes(Number(error.$metadata.httpStatusCode))));

const exactHeader = (request: IncomingMessage, name: string): string | undefined => {
	const values = request.headersDistinct[name];
	if (!values || values.length !== 1 || !values[0]) return undefined;
	return values[0];
};

const constantTimeEqual = (left: string, right: string): boolean => {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

const jsonProblem = (
	response: ServerResponse,
	status: number,
	code: string,
	detail: string,
	close = false
): void => {
	response.statusCode = status;
	response.setHeader('content-type', 'application/problem+json; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.setHeader('x-content-type-options', 'nosniff');
	if (close) response.setHeader('connection', 'close');
	response.end(
		JSON.stringify({
			type: `https://docs.boringcomputers.com/problems/${code}`,
			title: code,
			status,
			detail
		})
	);
};

const drainAndHash = async (
	request: IncomingMessage,
	expectedBytes: number,
	maximumBytes: number,
	abortSignal: AbortSignal
): Promise<string> => {
	let bytes = 0;
	const hash = createHash('sha256');
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.byteLength;
			if (bytes > expectedBytes || bytes > maximumBytes) {
				callback(new S3VolumeObjectStoreContractError('Volume upload exceeded its byte bound.'));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		}
	});
	await pipeline(
		request,
		meter,
		new Writable({
			write(_chunk, _encoding, done) {
				done();
			}
		}),
		{
			signal: abortSignal
		}
	);
	if (bytes !== expectedBytes) {
		throw new S3VolumeObjectStoreContractError(
			'Volume upload length did not match Content-Length.'
		);
	}
	return hash.digest('hex');
};

/**
 * Bounded, exact-key volume transport.
 *
 * The public capability reaches this broker, never S3. The broker keeps the
 * master storage principal private, verifies an HS256 header capability, and
 * streams one immutable revision into an exact reservation-derived key while
 * binding Content-Length, SHA-256 and SSE-S3 on the internal PutObject request.
 */
export class S3VolumeObjectStore implements VolumeObjectStore {
	readonly deletionMode = 'at-retention-boundary' as const;
	readonly reservationSettlementSeconds = reservationSettlementSeconds;
	readonly #bucket: string;
	readonly #brokerPublicUrl: URL;
	readonly #capabilityKey: Uint8Array;
	readonly #now: () => Date;
	readonly #send: S3VolumeObjectStoreDependencies['send'];

	constructor(
		config: S3VolumeObjectStoreConfig,
		dependencies: S3VolumeObjectStoreDependencies = {}
	) {
		const endpoint = validEndpoint(config.endpoint);
		validStorageConfig(config);
		this.#brokerPublicUrl = validBrokerUrl(config.brokerPublicUrl);
		this.#capabilityKey = capabilityKey(config.brokerSecret);
		this.#bucket = config.bucket;
		this.#now = dependencies.now ?? (() => new Date());
		const client = new S3Client({
			endpoint: endpoint.origin,
			region: config.region,
			forcePathStyle: config.forcePathStyle ?? false,
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
				...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken })
			}
		});
		this.#send =
			dependencies.send ??
			((command, options) =>
				client.send(
					command as never,
					options?.abortSignal ? { abortSignal: options.abortSignal } : undefined
				));
	}

	async inspect(input: {
		readonly organizationId: string;
		readonly projectId: string;
		readonly objectPrefix: string;
	}): Promise<{ readonly observedSizeBytes: number }> {
		const prefix = volumePrefix(input.organizationId, input.projectId, input.objectPrefix);
		const revisions = await this.#verifiedRevisions(input.organizationId, input.projectId, prefix);
		return {
			observedSizeBytes: revisions.reduce((sum, revision) => sum + revision.sizeBytes, 0)
		};
	}

	async issueGrant(input: {
		readonly organizationId: string;
		readonly projectId: string;
		readonly objectPrefix: string;
		readonly method: VolumeGrantMethod;
		readonly capabilityExpiresAt?: Date;
		readonly expiresAt: Date;
		readonly maximumBytes?: number;
		readonly requireEncryptionAtRest: true;
		readonly reservationId?: string;
	}): Promise<VolumeObjectGrant> {
		if (input.requireEncryptionAtRest !== true || !['GET', 'PUT'].includes(input.method)) {
			throw new S3VolumeObjectStoreContractError('Volume grant requirements are invalid.');
		}
		const prefix = volumePrefix(input.organizationId, input.projectId, input.objectPrefix);
		const requestedCapabilityExpiry = input.capabilityExpiresAt ?? input.expiresAt;
		if (requestedCapabilityExpiry > input.expiresAt) {
			throw new S3VolumeObjectStoreContractError(
				'Volume capability cannot outlive its durable reservation.'
			);
		}
		const { expiresAt, expiresEpoch } = this.#grantExpiry(requestedCapabilityExpiry);
		let claims: Omit<VolumeCapability, keyof JWTPayload> & JWTPayload;
		let maximumBytes: number | undefined;
		if (input.method === 'PUT') {
			if (
				!Number.isSafeInteger(input.maximumBytes) ||
				(input.maximumBytes ?? 0) < 1 ||
				!input.reservationId
			) {
				throw new S3VolumeObjectStoreContractError(
					'Volume PUT grant requires a bounded durable reservation.'
				);
			}
			maximumBytes = Math.min(input.maximumBytes!, maximumSinglePutBytes);
			claims = {
				method: 'PUT',
				organization_id: input.organizationId,
				project_id: input.projectId,
				object_prefix: prefix,
				object_key: revisionKey(prefix, input.reservationId),
				maximum_bytes: maximumBytes,
				reservation_id: input.reservationId.toLowerCase(),
				exp: expiresEpoch
			};
		} else {
			const revisions = await this.#verifiedRevisions(
				input.organizationId,
				input.projectId,
				prefix
			);
			const latest = revisions.sort(
				(left, right) =>
					right.lastModified.getTime() - left.lastModified.getTime() ||
					right.key.localeCompare(left.key)
			)[0];
			claims = latest
				? {
						method: 'GET',
						organization_id: input.organizationId,
						project_id: input.projectId,
						object_prefix: prefix,
						object_key: latest.key,
						size_bytes: latest.sizeBytes,
						checksum_sha256: latest.checksumHex,
						exp: expiresEpoch
					}
				: {
						method: 'GET',
						organization_id: input.organizationId,
						project_id: input.projectId,
						object_prefix: prefix,
						object_key: `${revisionPrefix(prefix)}empty.bin`,
						empty: true,
						exp: expiresEpoch
					};
		}
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: 'HS256', typ: 'volume-broker+jwt' })
			.setIssuer(capabilityIssuer)
			.setAudience(capabilityAudience)
			.sign(this.#capabilityKey);
		const grantId = createHash('sha256').update(token).digest('base64url');
		return {
			method: input.method,
			url: new URL(`/v1/volume-objects/${grantId}`, this.#brokerPublicUrl).href,
			objectPrefix: prefix,
			expiresAt,
			encryptionAtRest: true,
			headers: {
				[capabilityHeader]: token,
				...(input.method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {})
			},
			maximumBytes
		};
	}

	async scheduleDeletion(input: {
		readonly organizationId: string;
		readonly projectId: string;
		readonly objectPrefix: string;
		readonly deleteAfter: Date;
	}): Promise<void> {
		const prefix = volumePrefix(input.organizationId, input.projectId, input.objectPrefix);
		const now = this.#now();
		if (
			!Number.isFinite(input.deleteAfter.getTime()) ||
			input.deleteAfter.getTime() > now.getTime()
		) {
			throw new S3VolumeObjectStoreContractError(
				'Volume deletion cannot run before its retention boundary.'
			);
		}

		// Delete every historical version and delete marker. A final current-object
		// sweep covers unversioned S3-compatible stores. Repeating either phase is
		// safe after a timeout because DeleteObjects is idempotent for exact keys.
		for (let pass = 0; pass < maximumDeletePasses; pass += 1) {
			const listed = (await this.#send!(
				new ListObjectVersionsCommand({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1_000 })
			)) as {
				Versions?: Array<{ Key?: string; VersionId?: string }>;
				DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
			};
			const entries = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])];
			if (!entries.length) break;
			if (
				entries.some(
					(entry) =>
						!entry.Key?.startsWith(prefix) ||
						!entry.VersionId ||
						entry.VersionId.length > 1_024 ||
						/[\u0000-\u001f\u007f]/.test(entry.VersionId)
				)
			) {
				throw new S3VolumeObjectStoreContractError(
					'Object storage returned an invalid version during volume deletion.'
				);
			}
			await this.#deleteObjects(
				entries.map((entry) => ({ Key: entry.Key!, VersionId: entry.VersionId! }))
			);
			if (pass === maximumDeletePasses - 1) {
				throw new S3VolumeObjectStoreContractError('Volume version deletion did not converge.');
			}
		}

		for (let pass = 0; pass < maximumDeletePasses; pass += 1) {
			const listed = (await this.#send!(
				new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1_000 })
			)) as ListObjectsV2CommandOutput;
			const entries = (listed.Contents ?? []).map(({ Key }) => Key);
			if (!entries.length) return;
			if (entries.some((key) => !key?.startsWith(prefix))) {
				throw new S3VolumeObjectStoreContractError(
					'Object storage returned a cross-prefix key during volume deletion.'
				);
			}
			await this.#deleteObjects(entries.map((Key) => ({ Key: Key! })));
			if (pass === maximumDeletePasses - 1) {
				throw new S3VolumeObjectStoreContractError('Volume object deletion did not converge.');
			}
		}
	}

	matchesRequest(request: IncomingMessage): boolean {
		try {
			const url = new URL(request.url ?? '/', 'http://volume-broker.internal');
			return url.search === '' && /^\/v1\/volume-objects\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
		} catch {
			return false;
		}
	}

	async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://volume-broker.internal');
		const grantId = url.pathname.slice('/v1/volume-objects/'.length);
		const encodedCapability = exactHeader(request, capabilityHeader);
		if (!capabilityIdPattern.test(grantId) || !encodedCapability) {
			jsonProblem(response, 401, 'invalid_volume_capability', 'The volume capability is invalid.');
			return;
		}
		let capability: VerifiedCapability;
		try {
			capability = await this.#verifyCapability(grantId, encodedCapability);
		} catch {
			jsonProblem(
				response,
				401,
				'invalid_volume_capability',
				'The volume capability is invalid or expired.'
			);
			return;
		}
		if (request.method !== capability.method) {
			jsonProblem(
				response,
				405,
				'volume_method_denied',
				'The capability does not allow this method.'
			);
			return;
		}
		try {
			if (request.method === 'PUT') await this.#handlePut(request, response, capability);
			else await this.#handleGet(request, response, capability);
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (isNotFound(error)) {
				jsonProblem(response, 404, 'volume_object_not_found', 'The volume revision was not found.');
				return;
			}
			if (isPreconditionFailed(error)) {
				jsonProblem(
					response,
					409,
					'volume_revision_conflict',
					'This immutable volume revision already exists.'
				);
				return;
			}
			if (error instanceof S3VolumeObjectStoreContractError) {
				jsonProblem(response, 400, 'invalid_volume_transfer', error.message, true);
				return;
			}
			jsonProblem(
				response,
				502,
				'volume_storage_unavailable',
				'Durable volume storage is unavailable.',
				true
			);
		}
	}

	#grantExpiry(requestedExpiresAt: Date): {
		readonly expiresAt: Date;
		readonly expiresEpoch: number;
	} {
		const now = this.#now();
		if (!Number.isFinite(now.getTime()) || !Number.isFinite(requestedExpiresAt.getTime())) {
			throw new S3VolumeObjectStoreContractError('Volume grant expiry is invalid.');
		}
		const expiresEpoch = Math.floor(requestedExpiresAt.getTime() / 1_000);
		const expiresAt = new Date(expiresEpoch * 1_000);
		const ttlSeconds = expiresEpoch - Math.floor(now.getTime() / 1_000);
		if (
			ttlSeconds < 1 ||
			ttlSeconds > maximumGrantTtlSeconds ||
			expiresAt <= now ||
			expiresAt > requestedExpiresAt
		) {
			throw new S3VolumeObjectStoreContractError(
				'Volume grant expiry must be between 1 and 900 seconds.'
			);
		}
		return { expiresAt, expiresEpoch };
	}

	async #verifiedRevisions(
		organizationId: string,
		projectId: string,
		objectPrefix: string
	): Promise<Revision[]> {
		const revisions: Array<{ key: string; sizeBytes: number; lastModified: Date }> = [];
		let continuationToken: string | undefined;
		const seenTokens = new Set<string>();
		do {
			const page = (await this.#send!(
				new ListObjectsV2Command({
					Bucket: this.#bucket,
					Prefix: revisionPrefix(objectPrefix),
					MaxKeys: 1_000,
					...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken })
				})
			)) as ListObjectsV2CommandOutput;
			for (const item of page.Contents ?? []) {
				if (
					!item.Key ||
					!validRevisionKey(objectPrefix, item.Key) ||
					!Number.isSafeInteger(item.Size) ||
					(item.Size ?? 0) < 1 ||
					item.Size! > maximumSinglePutBytes ||
					!item.LastModified ||
					!Number.isFinite(item.LastModified.getTime())
				) {
					throw new S3VolumeObjectStoreContractError(
						'Object storage returned an invalid volume revision listing.'
					);
				}
				revisions.push({
					key: item.Key,
					sizeBytes: item.Size!,
					lastModified: item.LastModified
				});
			}
			if (!page.IsTruncated) break;
			if (!page.NextContinuationToken || seenTokens.has(page.NextContinuationToken)) {
				throw new S3VolumeObjectStoreContractError(
					'Object storage returned an invalid volume listing cursor.'
				);
			}
			seenTokens.add(page.NextContinuationToken);
			continuationToken = page.NextContinuationToken;
		} while (true);

		let observedSizeBytes = 0;
		const verified: Revision[] = [];
		for (let offset = 0; offset < revisions.length; offset += headConcurrency) {
			const heads = await Promise.all(
				revisions.slice(offset, offset + headConcurrency).map(async (revision) => ({
					...revision,
					...(await this.#headRevision(organizationId, projectId, objectPrefix, revision.key))
				}))
			);
			for (const revision of heads) {
				if (revision.sizeBytes !== revisions[verified.length]!.sizeBytes) {
					throw new S3VolumeObjectStoreContractError(
						'Volume revision changed while its allocation was inspected.'
					);
				}
				observedSizeBytes += revision.sizeBytes;
				if (!Number.isSafeInteger(observedSizeBytes) || observedSizeBytes > maximumVolumeBytes) {
					throw new S3VolumeObjectStoreContractError(
						'Stored volume revisions exceed the maximum supported allocation.'
					);
				}
				verified.push(revision);
			}
		}
		return verified;
	}

	async #headRevision(
		organizationId: string,
		projectId: string,
		objectPrefix: string,
		objectKey: string,
		abortSignal?: AbortSignal
	): Promise<{ readonly sizeBytes: number; readonly checksumHex: string }> {
		if (!validRevisionKey(objectPrefix, objectKey)) {
			throw new S3VolumeObjectStoreContractError(
				'Volume revision key is outside its tenant scope.'
			);
		}
		const reservationId = objectKey.slice(revisionPrefix(objectPrefix).length, -'.bin'.length);
		const head = (await this.#send!(
			new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey, ChecksumMode: 'ENABLED' }),
			abortSignal ? { abortSignal } : undefined
		)) as HeadObjectCommandOutput;
		const nativeChecksumHex = checksumHex(head.ChecksumSHA256);
		if (
			!Number.isSafeInteger(head.ContentLength) ||
			(head.ContentLength ?? 0) < 1 ||
			head.ContentLength! > maximumSinglePutBytes ||
			head.ServerSideEncryption !== 'AES256' ||
			(head.ChecksumType !== undefined && head.ChecksumType !== 'FULL_OBJECT') ||
			head.Metadata?.['nehemiah-sha256'] !== nativeChecksumHex ||
			head.Metadata?.['nehemiah-organization-id'] !== organizationId ||
			head.Metadata?.['nehemiah-project-id'] !== projectId ||
			head.Metadata?.['nehemiah-reservation-id'] !== reservationId
		) {
			throw new S3VolumeObjectStoreContractError(
				'Stored volume revision failed its size, encryption, checksum, or tenant contract.'
			);
		}
		return { sizeBytes: head.ContentLength!, checksumHex: nativeChecksumHex };
	}

	async #verifyCapability(grantId: string, encoded: string): Promise<VerifiedCapability> {
		if (!constantTimeEqual(createHash('sha256').update(encoded).digest('base64url'), grantId)) {
			throw new S3VolumeObjectStoreContractError('Volume capability path binding failed.');
		}
		const verified = await jwtVerify(encoded, this.#capabilityKey, {
			algorithms: ['HS256'],
			typ: 'volume-broker+jwt',
			issuer: capabilityIssuer,
			audience: capabilityAudience,
			currentDate: this.#now(),
			clockTolerance: 0
		});
		const claims = verified.payload as VolumeCapability;
		if (!Number.isSafeInteger(claims.exp) || (claims.exp ?? 0) < 1) {
			throw new S3VolumeObjectStoreContractError('Volume capability expiry is invalid.');
		}
		const expiresAt = new Date(claims.exp! * 1_000);
		const prefix = volumePrefix(claims.organization_id, claims.project_id, claims.object_prefix);
		if (claims.method === 'PUT') {
			if (
				!claims.reservation_id ||
				claims.object_key !== revisionKey(prefix, claims.reservation_id) ||
				!Number.isSafeInteger(claims.maximum_bytes) ||
				(claims.maximum_bytes ?? 0) < 1 ||
				claims.maximum_bytes! > maximumSinglePutBytes ||
				claims.size_bytes !== undefined ||
				claims.checksum_sha256 !== undefined ||
				claims.empty !== undefined
			) {
				throw new S3VolumeObjectStoreContractError('Volume PUT capability claims are invalid.');
			}
			return {
				method: 'PUT',
				organizationId: claims.organization_id,
				projectId: claims.project_id,
				objectPrefix: prefix,
				objectKey: claims.object_key,
				maximumBytes: claims.maximum_bytes,
				reservationId: claims.reservation_id.toLowerCase(),
				empty: false,
				expiresAt
			};
		}
		if (
			claims.method !== 'GET' ||
			claims.maximum_bytes !== undefined ||
			claims.reservation_id !== undefined
		) {
			throw new S3VolumeObjectStoreContractError('Volume GET capability claims are invalid.');
		}
		if (claims.empty === true) {
			if (
				claims.object_key !== `${revisionPrefix(prefix)}empty.bin` ||
				claims.size_bytes !== undefined ||
				claims.checksum_sha256 !== undefined
			) {
				throw new S3VolumeObjectStoreContractError('Empty volume capability claims are invalid.');
			}
			return {
				method: 'GET',
				organizationId: claims.organization_id,
				projectId: claims.project_id,
				objectPrefix: prefix,
				objectKey: claims.object_key,
				empty: true,
				expiresAt
			};
		}
		if (
			!validRevisionKey(prefix, claims.object_key) ||
			!Number.isSafeInteger(claims.size_bytes) ||
			(claims.size_bytes ?? 0) < 1 ||
			claims.size_bytes! > maximumSinglePutBytes ||
			!checksumPattern.test(`sha256:${claims.checksum_sha256 ?? ''}`) ||
			claims.empty !== undefined
		) {
			throw new S3VolumeObjectStoreContractError('Volume GET capability claims are invalid.');
		}
		return {
			method: 'GET',
			organizationId: claims.organization_id,
			projectId: claims.project_id,
			objectPrefix: prefix,
			objectKey: claims.object_key,
			sizeBytes: claims.size_bytes,
			checksumHex: claims.checksum_sha256,
			empty: false,
			expiresAt
		};
	}

	#transferSignal(
		request: IncomingMessage,
		response: ServerResponse,
		expiresAt: Date
	): AbortSignal {
		const remainingMs = expiresAt.getTime() - this.#now().getTime();
		if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
			throw new S3VolumeObjectStoreContractError('The volume capability expired.');
		}
		const disconnected = new AbortController();
		request.once('aborted', () => disconnected.abort());
		response.once('close', () => {
			if (!response.writableEnded) disconnected.abort();
		});
		return AbortSignal.any([disconnected.signal, AbortSignal.timeout(remainingMs)]);
	}

	async #handlePut(
		request: IncomingMessage,
		response: ServerResponse,
		capability: VerifiedCapability
	): Promise<void> {
		if (
			exactHeader(request, 'content-type') !== 'application/octet-stream' ||
			request.headersDistinct['transfer-encoding'] !== undefined ||
			request.headersDistinct['content-encoding'] !== undefined ||
			request.headersDistinct['content-range'] !== undefined ||
			request.headersDistinct.trailer !== undefined
		) {
			throw new S3VolumeObjectStoreContractError(
				'Volume PUT requires an unencoded application/octet-stream body.'
			);
		}
		const declaredLength = exactHeader(request, 'content-length');
		if (!declaredLength || !/^(?:[1-9][0-9]*)$/.test(declaredLength)) {
			throw new S3VolumeObjectStoreContractError(
				'Volume PUT requires one exact Content-Length header.'
			);
		}
		const contentLength = Number(declaredLength);
		if (
			!Number.isSafeInteger(contentLength) ||
			contentLength < 1 ||
			contentLength > (capability.maximumBytes ?? 0) ||
			contentLength > maximumSinglePutBytes
		) {
			jsonProblem(
				response,
				413,
				'volume_upload_too_large',
				'The upload exceeds this grant byte bound.',
				true
			);
			return;
		}
		const checksum = exactHeader(request, checksumHeader);
		const checksumMatch = checksum?.match(checksumPattern);
		if (!checksumMatch) {
			throw new S3VolumeObjectStoreContractError(
				'Volume PUT requires x-nehemiah-content-sha256: sha256:<64 lowercase hex>.'
			);
		}
		const expectedChecksumHex = checksumMatch[1]!;
		const expectedChecksumBase64 = Buffer.from(expectedChecksumHex, 'hex').toString('base64');

		const transferSignal = this.#transferSignal(request, response, capability.expiresAt);
		let existing: { sizeBytes: number; checksumHex: string } | undefined;
		try {
			existing = await this.#headRevision(
				capability.organizationId,
				capability.projectId,
				capability.objectPrefix,
				capability.objectKey,
				transferSignal
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		if (existing) {
			if (
				existing.sizeBytes !== contentLength ||
				!constantTimeEqual(existing.checksumHex, expectedChecksumHex)
			) {
				jsonProblem(
					response,
					409,
					'volume_revision_conflict',
					'This immutable reservation already contains a different revision.',
					true
				);
				return;
			}
			const actualChecksumHex = await drainAndHash(
				request,
				contentLength,
				capability.maximumBytes!,
				transferSignal
			);
			if (
				transferSignal.aborted ||
				this.#now() >= capability.expiresAt ||
				!constantTimeEqual(actualChecksumHex, expectedChecksumHex)
			) {
				throw new S3VolumeObjectStoreContractError('Volume upload SHA-256 did not match.');
			}
			response.statusCode = 204;
			response.setHeader('cache-control', 'no-store');
			response.end();
			return;
		}

		let measuredBytes = 0;
		const hash = createHash('sha256');
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				measuredBytes += chunk.byteLength;
				if (measuredBytes > contentLength || measuredBytes > capability.maximumBytes!) {
					callback(new S3VolumeObjectStoreContractError('Volume upload exceeded its byte bound.'));
					return;
				}
				hash.update(chunk);
				callback(null, chunk);
			}
		});
		request.pipe(meter);
		let result: PutObjectCommandOutput;
		try {
			result = (await this.#send!(
				new PutObjectCommand({
					Bucket: this.#bucket,
					Key: capability.objectKey,
					Body: meter,
					ContentType: 'application/octet-stream',
					ContentLength: contentLength,
					ChecksumAlgorithm: 'SHA256',
					ChecksumSHA256: expectedChecksumBase64,
					ServerSideEncryption: 'AES256',
					IfNoneMatch: '*',
					Metadata: {
						'nehemiah-sha256': expectedChecksumHex,
						'nehemiah-organization-id': capability.organizationId,
						'nehemiah-project-id': capability.projectId,
						'nehemiah-reservation-id': capability.reservationId!
					}
				}),
				{ abortSignal: transferSignal }
			)) as PutObjectCommandOutput;
		} catch (error) {
			request.unpipe(meter);
			meter.destroy();
			if (transferSignal.aborted) {
				throw new S3VolumeObjectStoreContractError(
					'Volume upload expired or its client disconnected.'
				);
			}
			throw error;
		}
		if (measuredBytes !== contentLength) {
			await this.#deleteFailedUpload(capability.objectKey, result.VersionId);
			throw new S3VolumeObjectStoreContractError(
				'Volume upload length did not match Content-Length.'
			);
		}
		const actualChecksumHex = hash.digest('hex');
		let confirmedChecksumHex: string | undefined;
		try {
			confirmedChecksumHex = checksumHex(result.ChecksumSHA256);
		} catch {
			// A provider that accepted the request but did not return the native
			// checksum cannot be trusted to have enforced it. Remove only this
			// reservation-derived immutable key before failing closed.
			await this.#deleteFailedUpload(capability.objectKey, result.VersionId);
			throw new S3VolumeObjectStoreContractError(
				'Object storage did not confirm the upload checksum contract.'
			);
		}
		if (
			transferSignal.aborted ||
			this.#now() >= capability.expiresAt ||
			!constantTimeEqual(actualChecksumHex, expectedChecksumHex) ||
			result.ServerSideEncryption !== 'AES256' ||
			confirmedChecksumHex !== expectedChecksumHex
		) {
			await this.#deleteFailedUpload(capability.objectKey, result.VersionId);
			throw new S3VolumeObjectStoreContractError(
				'Object storage did not confirm the upload checksum and encryption contract.'
			);
		}
		response.statusCode = 201;
		response.setHeader('cache-control', 'no-store');
		response.setHeader('digest', `sha-256=${expectedChecksumBase64}`);
		response.end();
	}

	async #handleGet(
		request: IncomingMessage,
		response: ServerResponse,
		capability: VerifiedCapability
	): Promise<void> {
		if (capability.empty) {
			jsonProblem(response, 404, 'volume_object_not_found', 'The volume has no revisions.');
			return;
		}
		if (
			request.headersDistinct.range !== undefined ||
			request.headersDistinct['if-range'] !== undefined
		) {
			throw new S3VolumeObjectStoreContractError('Volume downloads do not accept byte ranges.');
		}
		const transferSignal = this.#transferSignal(request, response, capability.expiresAt);
		const result = (await this.#send!(
			new GetObjectCommand({
				Bucket: this.#bucket,
				Key: capability.objectKey,
				ChecksumMode: 'ENABLED'
			}),
			{ abortSignal: transferSignal }
		)) as {
			Body?: unknown;
			ContentLength?: number;
			ContentType?: string;
			ChecksumSHA256?: string;
			ChecksumType?: string;
			ServerSideEncryption?: string;
			Metadata?: Record<string, string>;
		};
		const expectedChecksumBase64 = Buffer.from(capability.checksumHex!, 'hex').toString('base64');
		const expectedReservationId = capability.objectKey.slice(
			revisionPrefix(capability.objectPrefix).length,
			-'.bin'.length
		);
		if (
			result.ContentLength !== capability.sizeBytes ||
			result.ContentType !== 'application/octet-stream' ||
			result.ServerSideEncryption !== 'AES256' ||
			(result.ChecksumType !== undefined && result.ChecksumType !== 'FULL_OBJECT') ||
			checksumHex(result.ChecksumSHA256) !== capability.checksumHex ||
			result.Metadata?.['nehemiah-sha256'] !== capability.checksumHex ||
			result.Metadata?.['nehemiah-organization-id'] !== capability.organizationId ||
			result.Metadata?.['nehemiah-project-id'] !== capability.projectId ||
			result.Metadata?.['nehemiah-reservation-id'] !== expectedReservationId ||
			!(result.Body instanceof Readable)
		) {
			throw new S3VolumeObjectStoreContractError(
				'Stored volume revision failed its download contract.'
			);
		}
		response.statusCode = 200;
		response.setHeader('content-type', 'application/octet-stream');
		response.setHeader('content-length', String(capability.sizeBytes));
		response.setHeader('digest', `sha-256=${expectedChecksumBase64}`);
		response.setHeader('cache-control', 'private, no-store');
		response.setHeader('x-content-type-options', 'nosniff');
		await pipeline(result.Body, response, { signal: transferSignal });
	}

	async #deleteFailedUpload(objectKey: string, versionId: string | undefined): Promise<void> {
		if (
			versionId !== undefined &&
			(!versionId || versionId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(versionId))
		) {
			throw new S3VolumeObjectStoreContractError(
				'Object storage returned an invalid upload version identifier.'
			);
		}
		await this.#send!(
			new DeleteObjectCommand({
				Bucket: this.#bucket,
				Key: objectKey,
				...(versionId === undefined ? {} : { VersionId: versionId })
			})
		);
	}

	async #deleteObjects(objects: Array<{ Key: string; VersionId?: string }>): Promise<void> {
		if (!objects.length || objects.length > 1_000) {
			throw new S3VolumeObjectStoreContractError('Volume deletion batch is invalid.');
		}
		const result = (await this.#send!(
			new DeleteObjectsCommand({
				Bucket: this.#bucket,
				Delete: { Objects: objects, Quiet: true }
			})
		)) as { Errors?: unknown[] };
		if (result.Errors?.length) {
			throw new S3VolumeObjectStoreContractError(
				'Object storage rejected part of the volume deletion batch.'
			);
		}
	}
}
