import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	clientAddressHeader,
	clientSignatureHeader,
	clientTimestampHeader,
	verifiedClientAddress
} from './client-identity.js';
import { HttpRequestError } from './router.js';

export const maximumControlPlaneBodyBytes = 1_048_576;
export const maximumPendingRequestBodies = 64;
export const maximumPendingBodiesPerClient = 4;

export const controlPlaneHttpServerOptions = {
	headersTimeout: 10_000,
	requestTimeout: 30_000,
	keepAliveTimeout: 5_000,
	connectionsCheckingInterval: 1_000,
	maxHeaderSize: 16 * 1_024,
	requireHostHeader: true
} as const;

/**
 * Bounds requests that have reached Node but have not finished supplying their
 * bodies. Entries exist only while active and total cardinality is bounded by
 * the global ceiling. Admission is non-queued so slow senders cannot accumulate
 * promises, buffers, or database work behind this boundary.
 */
export class PendingRequestBodyAdmission {
	readonly #maximumTotal: number;
	readonly #maximumPerClient: number;
	readonly #byClient = new Map<string, number>();
	#total = 0;

	constructor(
		maximumTotal = maximumPendingRequestBodies,
		maximumPerClient = maximumPendingBodiesPerClient
	) {
		if (
			!Number.isSafeInteger(maximumTotal) ||
			!Number.isSafeInteger(maximumPerClient) ||
			maximumTotal < 1 ||
			maximumPerClient < 1 ||
			maximumPerClient > maximumTotal
		) {
			throw new Error('invalid pending request-body admission limits');
		}
		this.#maximumTotal = maximumTotal;
		this.#maximumPerClient = maximumPerClient;
	}

	tryAcquire(client: string): (() => void) | undefined {
		const current = this.#byClient.get(client) ?? 0;
		if (this.#total >= this.#maximumTotal || current >= this.#maximumPerClient) {
			return undefined;
		}
		this.#total += 1;
		this.#byClient.set(client, current + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#total -= 1;
			const remaining = (this.#byClient.get(client) ?? 1) - 1;
			if (remaining === 0) this.#byClient.delete(client);
			else this.#byClient.set(client, remaining);
		};
	}

	snapshot(): { readonly total: number; readonly clients: number } {
		return { total: this.#total, clients: this.#byClient.size };
	}
}

export interface PendingRequestBodyLease {
	readonly headers: Headers;
	readonly release: () => void;
}

export const sanitizedIncomingHeaders = (
	request: IncomingMessage,
	gatewayToken: string
): Headers => {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
		else if (value !== undefined) headers.set(name, value);
	}
	const clientAddress = verifiedClientAddress(headers, request.socket.remoteAddress, gatewayToken);
	// These headers are internal-only. Caller values are removed after the
	// signed gateway identity has been verified (or ignored in favor of the TCP
	// peer), so neither device issuance nor API admission trusts forwarding.
	headers.delete(clientAddressHeader);
	headers.delete(clientTimestampHeader);
	headers.delete(clientSignatureHeader);
	headers.delete('x-nehemiah-remote-address');
	headers.set(clientAddressHeader, clientAddress);
	headers.set('x-nehemiah-remote-address', clientAddress);
	return headers;
};

export const admitPendingRequestBody = (
	request: IncomingMessage,
	response: ServerResponse,
	gatewayToken: string,
	admission: PendingRequestBodyAdmission
): PendingRequestBodyLease | undefined => {
	const headers = sanitizedIncomingHeaders(request, gatewayToken);
	const release = admission.tryAcquire(headers.get(clientAddressHeader) ?? 'unknown');
	if (!release) {
		rejectPendingRequest(request, response);
		return undefined;
	}
	return { headers, release };
};

const validateDeclaredBodyLength = (
	request: IncomingMessage,
	maximum: number
): number | undefined => {
	const declared = request.headers['content-length'];
	if (declared === undefined) return undefined;
	if (Array.isArray(declared) || !/^(0|[1-9][0-9]*)$/.test(declared)) {
		throw new HttpRequestError(400, 'invalid_json', 'The request body length is invalid.');
	}
	const length = Number(declared);
	if (!Number.isSafeInteger(length)) {
		throw new HttpRequestError(400, 'invalid_json', 'The request body length is invalid.');
	}
	if (length > maximum) {
		throw new HttpRequestError(413, 'request_too_large', 'The request body is too large.');
	}
	return length;
};

export const incomingRequest = async (
	request: IncomingMessage,
	headers: Headers,
	maximumBodyBytes = maximumControlPlaneBodyBytes
): Promise<Request> => {
	const declaredLength = validateDeclaredBodyLength(request, maximumBodyBytes);
	const host = request.headers.host ?? 'localhost';
	const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
	if (
		(request.method === 'GET' || request.method === 'HEAD') &&
		((declaredLength ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined)
	) {
		throw new HttpRequestError(
			400,
			'invalid_json',
			'GET and HEAD request bodies are not accepted.'
		);
	}
	let body: Uint8Array | undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > maximumBodyBytes) {
				throw new HttpRequestError(413, 'request_too_large', 'The request body is too large.');
			}
			chunks.push(buffer);
		}
		body = Buffer.concat(chunks);
	}
	return new Request(`${protocol}://${host}${request.url ?? '/'}`, {
		method: request.method,
		headers,
		body: body as BodyInit | undefined
	});
};

export const rejectPendingRequest = (request: IncomingMessage, response: ServerResponse): void => {
	response.statusCode = 429;
	response.shouldKeepAlive = false;
	response.setHeader('connection', 'close');
	response.setHeader('retry-after', '1');
	response.setHeader('content-type', 'application/problem+json');
	response.once('finish', () => request.destroy());
	response.end(
		JSON.stringify({
			title: 'request_body_capacity_reached',
			status: 429,
			retry_after_seconds: 1
		})
	);
};

export const closeAfterResponse = (request: IncomingMessage, response: ServerResponse): void => {
	response.shouldKeepAlive = false;
	response.setHeader('connection', 'close');
	response.once('finish', () => request.destroy());
};
