import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
	S3ObjectStoreContractError,
	S3TemplateObjectStore,
	type S3TemplateObjectStoreConfig
} from '../../src/providers/storage/s3.js';

const now = new Date('2026-08-09T12:00:00.000Z');
const objectKey =
	'organizations/org-a/projects/project-a/templates/browser-ready/v1.2.3/123e4567-e89b-42d3-a456-426614174000/snapshot.tar.zst';
const config: S3TemplateObjectStoreConfig = {
	endpoint: 'https://objects.example.test',
	region: 'auto',
	bucket: 'nehemiah-template-artifacts',
	accessKeyId: 'scoped-control-plane-key',
	secretAccessKey: 'storage-secret-value',
	forcePathStyle: true
};

describe('S3-compatible template object storage', () => {
	it('issues short-lived exact-object grants bound to the exported checksum and size', async () => {
		const store = new S3TemplateObjectStore(config, { now: () => now });
		const expiresAt = new Date(now.getTime() + 600_999);
		const checksum = `sha256:${'ab'.repeat(32)}`;
		const upload = await store.createUploadGrant(
			objectKey,
			{ checksum, sizeBytes: 8_388_608 },
			expiresAt
		);
		const download = await store.createDownloadGrant(objectKey, expiresAt);

		expect(upload).toMatchObject({
			method: 'PUT',
			headers: {
				'x-amz-server-side-encryption': 'AES256',
				'if-none-match': '*',
				'content-length': '8388608'
			},
			expiresAt: new Date('2026-08-09T12:10:00.000Z')
		});
		expect(download).toMatchObject({
			method: 'GET',
			expiresAt: new Date('2026-08-09T12:10:00.000Z')
		});
		const uploadUrl = new URL(upload.url);
		expect(decodeURIComponent(uploadUrl.pathname)).toBe(`/${config.bucket}/${objectKey}`);
		expect(uploadUrl.searchParams.get('X-Amz-Expires')).toBe('600');
		expect(uploadUrl.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
			expect.arrayContaining(['host', 'if-none-match', 'x-amz-server-side-encryption'])
		);
		expect(uploadUrl.searchParams.has('x-amz-checksum-crc32')).toBe(false);
		expect(uploadUrl.searchParams.get('x-amz-sdk-checksum-algorithm')).toBe('SHA256');
		expect(uploadUrl.searchParams.get('x-amz-checksum-sha256')).toBe(
			Buffer.from('ab'.repeat(32), 'hex').toString('base64')
		);
		expect(upload.url).not.toContain(config.secretAccessKey);
		expect(decodeURIComponent(new URL(download.url).pathname)).toBe(
			`/${config.bucket}/${objectKey}`
		);
	});

	it('rejects an invalid checksum or an artifact too large for a single bound PUT', async () => {
		const store = new S3TemplateObjectStore(config, { now: () => now });
		const checksum = `sha256:${'ab'.repeat(32)}`;
		const grant = await store.createUploadGrant(
			objectKey,
			{ checksum, sizeBytes: 8_388_608 },
			new Date(now.getTime() + 300_000)
		);
		const url = new URL(grant.url);
		expect(grant.headers?.['content-length']).toBe('8388608');
		expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
		expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBe('SHA256');
		expect(url.searchParams.get('x-amz-checksum-sha256')).toBe(
			Buffer.from('ab'.repeat(32), 'hex').toString('base64')
		);
		expect(() =>
			store.createUploadGrant(
				objectKey,
				{ checksum: `sha256:${'A'.repeat(64)}`, sizeBytes: 8_388_608 },
				new Date(now.getTime() + 300_000)
			)
		).toThrow(S3ObjectStoreContractError);
		expect(() =>
			store.createUploadGrant(
				objectKey,
				{ checksum, sizeBytes: 5 * 1_024 * 1_024 * 1_024 + 1 },
				new Date(now.getTime() + 300_000)
			)
		).toThrow(S3ObjectStoreContractError);
	});

	it('uses immutable PUT commands and rejects capabilities outside the exact scope', async () => {
		let put: PutObjectCommand | undefined;
		const store = new S3TemplateObjectStore(config, {
			now: () => now,
			presign: async (command, options) => {
				if (command instanceof PutObjectCommand) put = command;
				return `https://elsewhere.example.test/${objectKey}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Expires=${options.expiresIn}&X-Amz-Signature=test&X-Amz-SignedHeaders=host%3Bif-none-match%3Bx-amz-server-side-encryption`;
			}
		});
		await expect(
			store.createUploadGrant(
				objectKey,
				{ checksum: `sha256:${'ab'.repeat(32)}`, sizeBytes: 1024 },
				new Date(now.getTime() + 60_000)
			)
		).rejects.toBeInstanceOf(S3ObjectStoreContractError);
		expect(put?.input).toMatchObject({
			Bucket: config.bucket,
			Key: objectKey,
			ServerSideEncryption: 'AES256',
			IfNoneMatch: '*'
		});
	});

	it('reads only a native full-object SHA-256 checksum with verified encryption and size', async () => {
		const digest = Buffer.from('ab'.repeat(32), 'hex');
		const send = vi.fn(async (command: HeadObjectCommand | DeleteObjectCommand) => {
			if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
			return {
				ContentLength: 8_388_608,
				ChecksumSHA256: digest.toString('base64'),
				ChecksumType: 'FULL_OBJECT',
				ServerSideEncryption: 'AES256'
			};
		});
		const store = new S3TemplateObjectStore(config, { send, now: () => now });

		await expect(store.stat(objectKey)).resolves.toEqual({
			checksum: `sha256:${'ab'.repeat(32)}`,
			sizeBytes: 8_388_608
		});
		const head = send.mock.calls[0]![0] as HeadObjectCommand;
		expect(head.input).toEqual({
			Bucket: config.bucket,
			Key: objectKey,
			ChecksumMode: 'ENABLED'
		});
	});

	it('fails closed for ETags, composite checksums, bad sizes, or missing encryption metadata', async () => {
		const digest = Buffer.from('cd'.repeat(32), 'hex').toString('base64');
		for (const output of [
			{ ContentLength: 10, ETag: `\"${'a'.repeat(64)}\"`, ServerSideEncryption: 'AES256' },
			{
				ContentLength: 10,
				ChecksumSHA256: `${digest}-2`,
				ChecksumType: 'COMPOSITE',
				ServerSideEncryption: 'AES256'
			},
			{ ContentLength: 0, ChecksumSHA256: digest, ServerSideEncryption: 'AES256' },
			{ ContentLength: 10, ChecksumSHA256: digest }
		]) {
			const store = new S3TemplateObjectStore(config, {
				send: async () => output,
				now: () => now
			});
			await expect(store.stat(objectKey)).rejects.toBeInstanceOf(S3ObjectStoreContractError);
		}
	});

	it('deletes the exact immutable key idempotently and refuses unmanaged keys or TTLs', async () => {
		const sent: Array<HeadObjectCommand | DeleteObjectCommand> = [];
		const store = new S3TemplateObjectStore(config, {
			now: () => now,
			send: async (command) => {
				sent.push(command);
				return command instanceof HeadObjectCommand ? { VersionId: 'version-one' } : {};
			}
		});
		await store.delete(objectKey);
		await store.delete(objectKey);
		expect(sent).toHaveLength(4);
		for (const [index, command] of sent.entries()) {
			if (index % 2 === 0) {
				expect(command).toBeInstanceOf(HeadObjectCommand);
				expect(command.input).toEqual({ Bucket: config.bucket, Key: objectKey });
			} else {
				expect(command).toBeInstanceOf(DeleteObjectCommand);
				expect(command.input).toEqual({
					Bucket: config.bucket,
					Key: objectKey,
					VersionId: 'version-one'
				});
			}
		}
		const missing = new S3TemplateObjectStore(config, {
			send: async () => {
				throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
			}
		});
		await expect(missing.delete(objectKey)).resolves.toBeUndefined();
		await expect(store.delete('../tenant/snapshot.tar.zst')).rejects.toBeInstanceOf(
			S3ObjectStoreContractError
		);
		await expect(
			store.createDownloadGrant(objectKey, new Date(now.getTime() + 901_000))
		).rejects.toBeInstanceOf(S3ObjectStoreContractError);
	});

	it('validates direct construction as strictly as service configuration', () => {
		const store = new S3TemplateObjectStore(config);
		expect(JSON.stringify(store)).not.toContain(config.secretAccessKey);
		expect(Object.keys(store)).not.toContain('config');
		expect(
			() => new S3TemplateObjectStore({ ...config, endpoint: 'http://objects.example.test' })
		).toThrow(S3ObjectStoreContractError);
		expect(() => new S3TemplateObjectStore({ ...config, bucket: 'Tenant_Bucket' })).toThrow(
			S3ObjectStoreContractError
		);
		expect(() => new S3TemplateObjectStore({ ...config, accessKeyId: 'bad key' })).toThrow(
			S3ObjectStoreContractError
		);
	});
});
