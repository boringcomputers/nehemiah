import { isIP } from 'node:net';
import { HostRequestError } from './nehemiahd.js';
import type { HostCredentialResolver } from '../domain/host-credentials.js';
import {
	validTemplateChecksum,
	type ScopedObjectGrant,
	type TemplatePublisher
} from '../domain/templates.js';
import type { TemplateActivator } from '../jobs/replicate-template.js';
import { injectTraceHeaders } from '../telemetry.js';

const exportIdPattern = /^te_[0-9a-f]{32}$/;
const hostTemplatePattern = /^t-[0-9a-f]{29}$/;
const maximumResponseBytes = 64 * 1024;
const maximumTemplateBytes = 5 * 1_024 * 1_024 * 1_024;

type Artifact = { readonly checksum: string; readonly sizeBytes: number };
type HostArtifactResponse = { readonly checksum: string; readonly size_bytes: number };

const validArtifact = (value: unknown): value is HostArtifactResponse => {
	if (typeof value !== 'object' || value === null) return false;
	const checksum = Reflect.get(value, 'checksum');
	const sizeBytes = Reflect.get(value, 'size_bytes');
	return (
		typeof checksum === 'string' &&
		validTemplateChecksum(checksum) &&
		Number.isSafeInteger(sizeBytes) &&
		Number(sizeBytes) > 0 &&
		Number(sizeBytes) <= maximumTemplateBytes
	);
};

const grantJson = (grant: ScopedObjectGrant) => ({
	method: grant.method,
	url: grant.url,
	headers: grant.headers ?? {},
	expires_at: grant.expiresAt.toISOString()
});

const normalizedOrigins = (origins: ReadonlyArray<string>): ReadonlySet<string> => {
	const result = new Set<string>();
	for (const value of origins) {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error('template object origins must be origin-only HTTPS URLs');
		}
		result.add(url.origin);
	}
	if (result.size === 0) throw new Error('at least one template object origin is required');
	return result;
};

const validateGrant = (
	grant: ScopedObjectGrant,
	method: ScopedObjectGrant['method'],
	allowedOrigins: ReadonlySet<string>,
	artifact?: Artifact
): void => {
	let url: URL;
	try {
		url = new URL(grant.url);
	} catch {
		throw new HostRequestError(undefined, 'template grant URL is invalid', false);
	}
	if (
		grant.method !== method ||
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.hash ||
		!allowedOrigins.has(url.origin)
	) {
		throw new HostRequestError(undefined, 'template grant is outside configured storage', false);
	}
	const headers = Object.entries(grant.headers ?? {});
	const normalized = new Map<string, string>();
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (
			normalized.has(lower) ||
			!/^[a-z0-9-]+$/.test(lower) ||
			value.length > 4_096 ||
			/[\r\n\0]/.test(value)
		) {
			throw new HostRequestError(undefined, 'template grant headers are invalid', false);
		}
		normalized.set(lower, value);
	}
	if (method === 'GET') {
		if (normalized.size !== 0) {
			throw new HostRequestError(undefined, 'template download grant headers are invalid', false);
		}
		return;
	}
	if (
		!artifact ||
		normalized.size !== 3 ||
		normalized.get('content-length') !== String(artifact.sizeBytes) ||
		normalized.get('if-none-match') !== '*' ||
		normalized.get('x-amz-server-side-encryption') !== 'AES256'
	) {
		throw new HostRequestError(undefined, 'template upload grant is not artifact-bound', false);
	}
};

export const templateObjectOrigins = (input: {
	readonly endpoint: string;
	readonly bucket: string;
	readonly forcePathStyle: boolean;
}): ReadonlyArray<string> => {
	const endpoint = new URL(input.endpoint);
	if (input.forcePathStyle) return [endpoint.origin];
	const virtual = new URL(endpoint.origin);
	virtual.hostname = `${input.bucket}.${endpoint.hostname}`;
	return [endpoint.origin, virtual.origin];
};

/** Private host adapter for the export-first publication and checksum-verified
 * activation contracts. Each call resolves the target host's unique inbound
 * credential; no fleet-wide or object-store master credential is forwarded. */
export class NehemiahdTemplateClient implements TemplatePublisher, TemplateActivator {
	readonly #origins: ReadonlySet<string>;

	constructor(
		private readonly credentials: HostCredentialResolver,
		allowedObjectOrigins: ReadonlyArray<string>,
		private readonly fetcher: typeof fetch = fetch,
		private readonly requestTimeoutMs = 15 * 60 * 1_000,
		private readonly hostPort = 8080
	) {
		this.#origins = normalizedOrigins(allowedObjectOrigins);
		if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
			throw new Error('template host timeout must be at least one second');
		}
		if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
			throw new Error('host port must be between 1 and 65535');
		}
	}

	async export(input: Parameters<TemplatePublisher['export']>[0]) {
		if (!exportIdPattern.test(input.exportId)) {
			throw new HostRequestError(undefined, 'template export id is invalid', false);
		}
		const result = await this.#request<unknown>(
			input.address,
			`/internal/v1/machines/${encodeURIComponent(input.hostMachineId)}/template-exports`,
			{
				method: 'POST',
				headers: { 'x-nehemiah-lease-id': input.leaseId },
				body: JSON.stringify({ export_id: input.exportId })
			}
		);
		if (!validArtifact(result) || Reflect.get(result, 'export_id') !== input.exportId) {
			throw new HostRequestError(undefined, 'host returned an invalid template export', true);
		}
		return {
			exportId: input.exportId,
			checksum: result.checksum,
			sizeBytes: result.size_bytes
		};
	}

	async upload(input: Parameters<TemplatePublisher['upload']>[0]) {
		if (!exportIdPattern.test(input.exportId)) {
			throw new HostRequestError(undefined, 'template export id is invalid', false);
		}
		validateGrant(input.upload, 'PUT', this.#origins, input.artifact);
		const result = await this.#request<unknown>(
			input.address,
			`/internal/v1/machines/${encodeURIComponent(input.hostMachineId)}/template-exports/${encodeURIComponent(input.exportId)}/upload`,
			{
				method: 'POST',
				headers: { 'x-nehemiah-lease-id': input.leaseId },
				body: JSON.stringify({
					checksum: input.artifact.checksum,
					size_bytes: input.artifact.sizeBytes,
					upload: grantJson(input.upload)
				})
			}
		);
		if (!validArtifact(result)) {
			throw new HostRequestError(undefined, 'host returned an invalid template upload', true);
		}
		return {
			checksum: result.checksum,
			sizeBytes: result.size_bytes
		};
	}

	async discard(input: Parameters<TemplatePublisher['discard']>[0]): Promise<void> {
		if (!exportIdPattern.test(input.exportId)) return;
		try {
			await this.#request(
				input.address,
				`/internal/v1/machines/${encodeURIComponent(input.hostMachineId)}/template-exports/${encodeURIComponent(input.exportId)}`,
				{
					method: 'DELETE',
					headers: { 'x-nehemiah-lease-id': input.leaseId }
				}
			);
		} catch (error) {
			if (!(error instanceof HostRequestError && error.status === 404)) throw error;
		}
	}

	async activate(input: Parameters<TemplateActivator['activate']>[0]) {
		if (!hostTemplatePattern.test(input.hostTemplateName)) {
			throw new HostRequestError(undefined, 'host template name is invalid', false);
		}
		const artifact = { checksum: input.checksum, sizeBytes: input.sizeBytes };
		if (!validTemplateChecksum(artifact.checksum) || !Number.isSafeInteger(artifact.sizeBytes)) {
			throw new HostRequestError(undefined, 'template activation artifact is invalid', false);
		}
		validateGrant(input.download, 'GET', this.#origins);
		const result = await this.#request<unknown>(
			input.address,
			`/internal/v1/templates/${encodeURIComponent(input.hostTemplateName)}/activate`,
			{
				method: 'POST',
				body: JSON.stringify({
					format: 'firecracker-snapshot-v1',
					architecture: input.architecture,
					checksum: input.checksum,
					size_bytes: input.sizeBytes,
					download: grantJson(input.download)
				})
			}
		);
		if (!validArtifact(result)) {
			throw new HostRequestError(undefined, 'host returned an invalid template activation', true);
		}
		return {
			checksum: result.checksum,
			sizeBytes: result.size_bytes
		};
	}

	async #request<T>(address: string, path: string, init: RequestInit): Promise<T> {
		const version = isIP(address);
		if (version === 0) throw new HostRequestError(undefined, 'invalid host address', false);
		const credential = await this.credentials.resolve(address);
		const base = `http://${version === 6 ? `[${address}]` : address}:${this.hostPort}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		try {
			const headers = new Headers(init.headers);
			headers.set('accept', 'application/json');
			headers.set('content-type', 'application/json');
			headers.set('authorization', `Bearer ${credential}`);
			injectTraceHeaders(headers);
			const response = await this.fetcher(`${base}${path}`, {
				...init,
				signal: controller.signal,
				redirect: 'error',
				headers: Object.fromEntries(headers.entries())
			});
			const bytes = await readBounded(response, maximumResponseBytes);
			if (!response.ok) {
				const body = new TextDecoder().decode(bytes);
				let code: string | undefined;
				try {
					const decoded = JSON.parse(body) as unknown;
					const candidate =
						typeof decoded === 'object' && decoded !== null
							? Reflect.get(decoded, 'error')
							: undefined;
					if (typeof candidate === 'string') code = candidate;
				} catch {
					// Retain the bounded body as the diagnostic below.
				}
				throw new HostRequestError(
					response.status,
					body,
					response.status >= 500 || response.status === 408 || response.status === 429,
					code
				);
			}
			if (response.status === 204) return undefined as T;
			return JSON.parse(new TextDecoder().decode(bytes)) as T;
		} catch (error) {
			if (error instanceof HostRequestError) throw error;
			throw new HostRequestError(
				undefined,
				error instanceof Error ? error.message : String(error),
				true
			);
		} finally {
			clearTimeout(timer);
		}
	}
}

const readBounded = async (response: Response, maximum: number): Promise<Uint8Array> => {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maximum) {
		throw new Error('host template response is too large');
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximum) {
			await reader.cancel();
			throw new Error('host template response is too large');
		}
		chunks.push(value);
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};
