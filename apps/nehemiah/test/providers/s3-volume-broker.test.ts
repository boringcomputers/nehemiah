import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectVersionsCommand,
	ListObjectsV2Command,
	PutObjectCommand
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import {
	S3VolumeObjectStore,
	S3VolumeObjectStoreContractError,
	type S3VolumeObjectStoreConfig
} from '../../src/providers/storage/s3-volumes.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const objectPrefix =
	'organizations/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/volumes/vol_1234567890abcdef/';
const baseNow = new Date('2026-08-09T12:00:00.000Z');
const config: S3VolumeObjectStoreConfig = {
	endpoint: 'https://objects.example.test',
	region: 'ca-central-1',
	bucket: 'nehemiah-volume-artifacts',
	accessKeyId: 'scoped-volume-broker-key',
	secretAccessKey: 'scoped-volume-broker-secret',
	brokerPublicUrl: 'https://volumes.example.test',
	brokerSecret: Buffer.alloc(32, 7).toString('base64')
};

interface StoredRevision {
	readonly body: Buffer;
	readonly checksumBase64: string;
	readonly metadata: Record<string, string>;
	readonly lastModified: Date;
	readonly versionId: string;
}

const notFound = (): Error =>
	Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

class MemoryS3 {
	readonly objects = new Map<string, StoredRevision>();
	readonly commands: unknown[] = [];
	now = baseNow;
	putResultOverride?: { ChecksumSHA256?: string; ServerSideEncryption?: string };
	afterPut?: () => void;

	readonly send = async (command: unknown): Promise<unknown> => {
		this.commands.push(command);
		if (command instanceof ListObjectsV2Command) {
			const prefix = command.input.Prefix ?? '';
			return {
				IsTruncated: false,
				Contents: [...this.objects.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([Key, revision]) => ({
						Key,
						Size: revision.body.byteLength,
						LastModified: revision.lastModified
					}))
			};
		}
		if (command instanceof HeadObjectCommand) {
			const revision = this.objects.get(command.input.Key!);
			if (!revision) throw notFound();
			return {
				ContentLength: revision.body.byteLength,
				ContentType: 'application/octet-stream',
				ChecksumSHA256: revision.checksumBase64,
				ChecksumType: 'FULL_OBJECT',
				ServerSideEncryption: 'AES256',
				Metadata: revision.metadata,
				VersionId: revision.versionId
			};
		}
		if (command instanceof PutObjectCommand) {
			if (this.objects.has(command.input.Key!)) {
				throw Object.assign(new Error('exists'), {
					name: 'PreconditionFailed',
					$metadata: { httpStatusCode: 412 }
				});
			}
			const chunks: Buffer[] = [];
			for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const versionId = randomUUID();
			this.objects.set(command.input.Key!, {
				body,
				checksumBase64: command.input.ChecksumSHA256!,
				metadata: command.input.Metadata!,
				lastModified: this.now,
				versionId
			});
			this.afterPut?.();
			return {
				ChecksumSHA256: command.input.ChecksumSHA256,
				ServerSideEncryption: 'AES256',
				VersionId: versionId,
				...this.putResultOverride
			};
		}
		if (command instanceof GetObjectCommand) {
			const revision = this.objects.get(command.input.Key!);
			if (!revision) throw notFound();
			return {
				Body: Readable.from(revision.body),
				ContentLength: revision.body.byteLength,
				ContentType: 'application/octet-stream',
				ChecksumSHA256: revision.checksumBase64,
				ChecksumType: 'FULL_OBJECT',
				ServerSideEncryption: 'AES256',
				Metadata: revision.metadata
			};
		}
		if (command instanceof ListObjectVersionsCommand) {
			const prefix = command.input.Prefix ?? '';
			return {
				Versions: [...this.objects.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([Key, revision]) => ({ Key, VersionId: revision.versionId }))
			};
		}
		if (command instanceof DeleteObjectsCommand) {
			for (const object of command.input.Delete?.Objects ?? []) this.objects.delete(object.Key!);
			return { Errors: [] };
		}
		if (command instanceof DeleteObjectCommand) {
			this.objects.delete(command.input.Key!);
			return {};
		}
		throw new Error(`unexpected command: ${String(command)}`);
	};
}

const checksum = (body: Buffer): string =>
	`sha256:${createHash('sha256').update(body).digest('hex')}`;

const putGrant = (
	store: S3VolumeObjectStore,
	maximumBytes = 1_048_576,
	reservationId = '33333333-3333-4333-8333-333333333333'
) =>
	store.issueGrant({
		organizationId,
		projectId,
		objectPrefix,
		method: 'PUT',
		expiresAt: new Date(baseNow.getTime() + 60_000),
		maximumBytes,
		requireEncryptionAtRest: true,
		reservationId
	});

const readGrant = (store: S3VolumeObjectStore) =>
	store.issueGrant({
		organizationId,
		projectId,
		objectPrefix,
		method: 'GET',
		expiresAt: new Date(baseNow.getTime() + 60_000),
		requireEncryptionAtRest: true
	});

const listen = async (
	store: S3VolumeObjectStore
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> => {
	const server: Server = createServer((request, response) => {
		if (!store.matchesRequest(request)) {
			response.writeHead(404).end();
			return;
		}
		void store.handleRequest(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('test server did not bind');
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			)
	};
};

const localGrantUrl = (origin: string, grantUrl: string): string => {
	const url = new URL(grantUrl);
	return `${origin}${url.pathname}`;
};

describe('bounded S3 volume object broker', () => {
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it('mints a deterministic short-lived exact-key PUT capability without exposing S3 credentials', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const first = await putGrant(store);
		const replay = await putGrant(store);

		expect(replay).toEqual(first);
		expect(first).toMatchObject({
			method: 'PUT',
			objectPrefix,
			maximumBytes: 1_048_576,
			encryptionAtRest: true,
			headers: { 'content-type': 'application/octet-stream' }
		});
		expect(new URL(first.url)).toMatchObject({
			origin: 'https://volumes.example.test',
			search: '',
			hash: ''
		});
		expect(first.url).not.toContain(config.accessKeyId);
		expect(JSON.stringify(first.headers)).not.toContain(config.secretAccessKey);
		expect(first.headers?.['x-nehemiah-volume-capability']).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
	});

	it('streams a checksum-bound encrypted PUT and a verified GET without buffering in the API router', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const server = await listen(store);
		servers.push(server);
		const body = Buffer.from('tenant-safe durable bytes');
		const grant = await putGrant(store);
		const uploaded = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(body) },
			body
		});
		expect(uploaded.status).toBe(201);
		expect(uploaded.headers.get('digest')).toBe(
			`sha-256=${createHash('sha256').update(body).digest('base64')}`
		);

		const put = memory.commands.find((command) => command instanceof PutObjectCommand);
		expect(put).toBeInstanceOf(PutObjectCommand);
		expect((put as PutObjectCommand).input).toMatchObject({
			ContentLength: body.byteLength,
			ChecksumAlgorithm: 'SHA256',
			ServerSideEncryption: 'AES256',
			IfNoneMatch: '*',
			Metadata: {
				'nehemiah-organization-id': organizationId,
				'nehemiah-project-id': projectId,
				'nehemiah-reservation-id': '33333333-3333-4333-8333-333333333333'
			}
		});
		expect((put as PutObjectCommand).input.Key).toBe(
			`${objectPrefix}revisions/33333333-3333-4333-8333-333333333333.bin`
		);
		expect(await store.inspect({ organizationId, projectId, objectPrefix })).toEqual({
			observedSizeBytes: body.byteLength
		});

		const download = await readGrant(store);
		const downloaded = await fetch(localGrantUrl(server.origin, download.url), {
			headers: download.headers
		});
		expect(downloaded.status).toBe(200);
		expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(body);
		expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
	});

	it('rejects over-limit, missing-checksum, tampered, cross-grant, and expired uploads', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const server = await listen(store);
		servers.push(server);
		const grant = await putGrant(store, 3);
		const second = await putGrant(store, 3, '44444444-4444-4444-8444-444444444444');
		const body = Buffer.from('four');

		const tooLarge = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(body) },
			body
		});
		expect(tooLarge.status).toBe(413);

		const missingChecksum = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: grant.headers,
			body: Buffer.from('ok')
		});
		expect(missingChecksum.status).toBe(400);

		const tamperedPath = new URL(grant.url);
		tamperedPath.pathname = `${tamperedPath.pathname.slice(0, -1)}A`;
		const tampered = await fetch(localGrantUrl(server.origin, tamperedPath.href), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(Buffer.from('ok')) },
			body: Buffer.from('ok')
		});
		expect(tampered.status).toBe(401);

		const crossed = await fetch(localGrantUrl(server.origin, second.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(Buffer.from('ok')) },
			body: Buffer.from('ok')
		});
		expect(crossed.status).toBe(401);

		memory.now = new Date(baseNow.getTime() + 61_000);
		const expired = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(Buffer.from('ok')) },
			body: Buffer.from('ok')
		});
		expect(expired.status).toBe(401);
		expect(memory.objects.size).toBe(0);
	});

	it('removes a provider-accepted digest mismatch and replays only byte-identical revisions', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const server = await listen(store);
		servers.push(server);
		const body = Buffer.from('actual content');
		const falseDigest = checksum(Buffer.from('different content'));
		const grant = await putGrant(store);

		const rejected = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': falseDigest },
			body
		});
		expect(rejected.status).toBe(400);
		expect(memory.objects.size).toBe(0);
		expect(memory.commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);

		const goodDigest = checksum(body);
		const created = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': goodDigest },
			body
		});
		expect(created.status).toBe(201);
		const replayed = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': goodDigest },
			body
		});
		expect(replayed.status).toBe(204);
		const conflictBody = Buffer.from('conflicting bytes');
		const conflict = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: {
				...grant.headers,
				'x-nehemiah-content-sha256': checksum(conflictBody)
			},
			body: conflictBody
		});
		expect(conflict.status).toBe(409);
		expect(memory.objects.size).toBe(1);
	});

	it('removes a revision if the provider finishes after the public capability deadline', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const server = await listen(store);
		servers.push(server);
		const body = Buffer.from('too late to commit');
		const grant = await putGrant(store);
		memory.afterPut = () => {
			memory.now = new Date(baseNow.getTime() + 61_000);
		};

		const response = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(body) },
			body
		});
		expect(response.status).toBe(400);
		expect(memory.objects.size).toBe(0);
		expect(memory.commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
	});

	it('fails closed on tampered storage metadata and deletes all versions only after retention', async () => {
		const memory = new MemoryS3();
		const store = new S3VolumeObjectStore(config, { send: memory.send, now: () => memory.now });
		const server = await listen(store);
		servers.push(server);
		const body = Buffer.from('retained');
		const grant = await putGrant(store);
		const uploaded = await fetch(localGrantUrl(server.origin, grant.url), {
			method: 'PUT',
			headers: { ...grant.headers, 'x-nehemiah-content-sha256': checksum(body) },
			body
		});
		expect(uploaded.status).toBe(201);

		const [key, revision] = [...memory.objects.entries()][0]!;
		memory.objects.set(key, {
			...revision,
			metadata: { ...revision.metadata, 'nehemiah-project-id': randomUUID() }
		});
		await expect(store.inspect({ organizationId, projectId, objectPrefix })).rejects.toBeInstanceOf(
			S3VolumeObjectStoreContractError
		);
		memory.objects.set(key, revision);

		const deleteAfter = new Date(baseNow.getTime() + 10_000);
		await expect(
			store.scheduleDeletion({ organizationId, projectId, objectPrefix, deleteAfter })
		).rejects.toBeInstanceOf(S3VolumeObjectStoreContractError);
		expect(memory.objects.size).toBe(1);
		memory.now = deleteAfter;
		await store.scheduleDeletion({ organizationId, projectId, objectPrefix, deleteAfter });
		expect(memory.objects.size).toBe(0);
		await store.scheduleDeletion({ organizationId, projectId, objectPrefix, deleteAfter });
	});

	it('rejects weak broker configuration and cross-tenant object prefixes', async () => {
		expect(
			() => new S3VolumeObjectStore({ ...config, brokerPublicUrl: 'http://localhost:8081' })
		).toThrow(S3VolumeObjectStoreContractError);
		expect(() => new S3VolumeObjectStore({ ...config, brokerSecret: 'weak' })).toThrow(
			S3VolumeObjectStoreContractError
		);
		const store = new S3VolumeObjectStore(config, {
			send: new MemoryS3().send,
			now: () => baseNow
		});
		await expect(
			store.issueGrant({
				organizationId,
				projectId: randomUUID(),
				objectPrefix,
				method: 'PUT',
				expiresAt: new Date(baseNow.getTime() + 60_000),
				maximumBytes: 10,
				requireEncryptionAtRest: true,
				reservationId: randomUUID()
			})
		).rejects.toBeInstanceOf(S3VolumeObjectStoreContractError);
	});
});
