import { describe, expect, it, vi } from 'vitest';
import type { HostCredentialResolver } from '../../src/domain/host-credentials.js';
import type { ScopedObjectGrant } from '../../src/domain/templates.js';
import {
	NehemiahdTemplateClient,
	templateObjectOrigins
} from '../../src/clients/nehemiahd-templates.js';
import { HostRequestError } from '../../src/clients/nehemiahd.js';

const checksum = `sha256:${'ab'.repeat(32)}`;
const expiresAt = new Date(Date.now() + 5 * 60 * 1_000);
const artifact = { checksum, sizeBytes: 8_388_608 };
const upload: ScopedObjectGrant = {
	method: 'PUT',
	url: 'https://objects.example.test/bucket/exact?signature=scoped',
	headers: {
		'content-length': String(artifact.sizeBytes),
		'if-none-match': '*',
		'x-amz-server-side-encryption': 'AES256'
	},
	expiresAt
};
const download: ScopedObjectGrant = {
	method: 'GET',
	url: 'https://objects.example.test/bucket/exact?signature=scoped',
	expiresAt
};

class CredentialResolver implements HostCredentialResolver {
	readonly calls: string[] = [];
	async resolve(address: string): Promise<string> {
		this.calls.push(address);
		return 'host-specific-control-credential'.padEnd(48, 'x');
	}
}

describe('managed template host client', () => {
	it('uses lease-bound export/upload routes and a host-authenticated activation route', async () => {
		const requests: Array<{ url: string; init: RequestInit; body?: unknown }> = [];
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			requests.push({ url: String(url), init: init ?? {}, body: parsedBody });
			if (String(url).endsWith('/template-exports')) {
				return Response.json({
					export_id: `te_${'a'.repeat(32)}`,
					checksum,
					size_bytes: artifact.sizeBytes
				});
			}
			if (init?.method === 'DELETE') return new Response(null, { status: 204 });
			return Response.json({ checksum, size_bytes: artifact.sizeBytes });
		}) as typeof fetch;
		const credentials = new CredentialResolver();
		const client = new NehemiahdTemplateClient(
			credentials,
			['https://objects.example.test'],
			fetcher,
			5_000,
			8080
		);
		const source = {
			address: '10.64.0.2',
			hostMachineId: 'm-12345678',
			leaseId: 'lease-current',
			exportId: `te_${'a'.repeat(32)}`
		};

		expect(await client.export(source)).toEqual({ ...artifact, exportId: source.exportId });
		expect(await client.upload({ ...source, artifact, upload })).toEqual(artifact);
		expect(
			await client.activate({
				address: source.address,
				hostTemplateName: `t-${'b'.repeat(29)}`,
				architecture: 'x86_64',
				...artifact,
				download
			})
		).toEqual(artifact);
		await client.discard(source);

		expect(credentials.calls).toEqual(Array(4).fill(source.address));
		expect(requests.map(({ init }) => init.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
		for (const request of requests) {
			expect(new Headers(request.init.headers).get('authorization')).toBe(
				`Bearer ${'host-specific-control-credential'.padEnd(48, 'x')}`
			);
		}
		expect(new Headers(requests[0]!.init.headers).get('x-nehemiah-lease-id')).toBe('lease-current');
		expect(new Headers(requests[1]!.init.headers).get('x-nehemiah-lease-id')).toBe('lease-current');
		expect(new Headers(requests[2]!.init.headers).has('x-nehemiah-lease-id')).toBe(false);
		expect(JSON.stringify(requests)).not.toContain('storage-master-secret');
	});

	it('rejects a grant outside the configured storage origin before contacting a host', async () => {
		const credentials = new CredentialResolver();
		const fetcher = vi.fn() as unknown as typeof fetch;
		const client = new NehemiahdTemplateClient(
			credentials,
			['https://objects.example.test'],
			fetcher
		);
		await expect(
			client.upload({
				address: '10.64.0.2',
				hostMachineId: 'm-12345678',
				leaseId: 'lease-current',
				exportId: `te_${'a'.repeat(32)}`,
				artifact,
				upload: { ...upload, url: 'https://metadata.internal/latest' }
			})
		).rejects.toBeInstanceOf(HostRequestError);
		expect(credentials.calls).toHaveLength(0);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('derives only the configured path-style or exact bucket virtual-host origin', () => {
		expect(
			templateObjectOrigins({
				endpoint: 'https://objects.example.test',
				bucket: 'tenant-artifacts',
				forcePathStyle: true
			})
		).toEqual(['https://objects.example.test']);
		expect(
			templateObjectOrigins({
				endpoint: 'https://objects.example.test',
				bucket: 'tenant-artifacts',
				forcePathStyle: false
			})
		).toEqual(['https://objects.example.test', 'https://tenant-artifacts.objects.example.test']);
	});
});
