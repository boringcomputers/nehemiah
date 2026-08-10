import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
	admitPendingRequestBody,
	closeAfterResponse,
	controlPlaneHttpServerOptions,
	incomingRequest,
	PendingRequestBodyAdmission
} from '../../src/http/incoming-request.js';
import { HttpRequestError } from '../../src/http/router.js';

const gatewayToken = 'test-gateway-token-with-at-least-thirty-two-characters';

const waitFor = async (predicate: () => boolean): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for HTTP admission state');
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
};

const responseStatus = (request: ClientRequest): Promise<number> =>
	new Promise((resolve, reject) => {
		request.once('response', (response: IncomingMessage) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.once('error', reject);
	});

describe('early HTTP request-body admission', () => {
	const openServers: Array<ReturnType<typeof createServer>> = [];
	const openRequests: ClientRequest[] = [];

	afterEach(async () => {
		for (const request of openRequests.splice(0)) request.destroy();
		await Promise.all(
			openServers.splice(0).map(async (server) => {
				server.closeAllConnections();
				server.close();
				await once(server, 'close').catch(() => undefined);
			})
		);
	});

	it('rejects parallel slow bodies before routing and releases slots on disconnect', async () => {
		const admission = new PendingRequestBodyAdmission(2, 2);
		let routed = 0;
		const server = createServer(controlPlaneHttpServerOptions, (request, response) => {
			const lease = admitPendingRequestBody(request, response, gatewayToken, admission);
			if (!lease) return;
			void (async () => {
				try {
					await incomingRequest(request, lease.headers, 64);
					routed += 1;
					response.statusCode = 204;
					response.end();
				} catch (error) {
					if (error instanceof HttpRequestError) {
						closeAfterResponse(request, response);
						response.statusCode = error.status;
						response.end();
					}
				} finally {
					lease.release();
				}
			})();
		});
		openServers.push(server);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('missing test listener');

		const slow = (): ClientRequest => {
			const request = httpRequest({
				host: '127.0.0.1',
				port: address.port,
				path: '/v1/machines',
				method: 'POST',
				headers: { 'transfer-encoding': 'chunked' }
			});
			request.on('error', () => undefined);
			request.write('{');
			openRequests.push(request);
			return request;
		};
		const first = slow();
		const second = slow();
		await waitFor(() => admission.snapshot().total === 2);

		const rejected = httpRequest({
			host: '127.0.0.1',
			port: address.port,
			path: '/v1/machines',
			method: 'POST',
			headers: { 'content-type': 'application/json' }
		});
		openRequests.push(rejected);
		const rejectedStatus = responseStatus(rejected);
		rejected.end('{}');
		expect(await rejectedStatus).toBe(429);
		expect(routed).toBe(0);

		first.destroy();
		await waitFor(() => admission.snapshot().total === 1);
		const accepted = httpRequest({
			host: '127.0.0.1',
			port: address.port,
			path: '/v1/machines',
			method: 'POST',
			headers: { 'content-type': 'application/json' }
		});
		openRequests.push(accepted);
		const acceptedStatus = responseStatus(accepted);
		accepted.end('{}');
		expect(await acceptedStatus).toBe(204);
		expect(routed).toBe(1);

		second.destroy();
		await waitFor(() => admission.snapshot().total === 0);
	});

	it('rejects an oversized declared body before reading or routing it', async () => {
		const admission = new PendingRequestBodyAdmission(2, 2);
		let routed = 0;
		const server = createServer(controlPlaneHttpServerOptions, (request, response) => {
			const lease = admitPendingRequestBody(request, response, gatewayToken, admission);
			if (!lease) return;
			void incomingRequest(request, lease.headers, 8)
				.then(() => {
					routed += 1;
					response.statusCode = 204;
					response.end();
				})
				.catch((error: unknown) => {
					if (!(error instanceof HttpRequestError)) throw error;
					closeAfterResponse(request, response);
					response.statusCode = error.status;
					response.end();
				})
				.finally(lease.release);
		});
		openServers.push(server);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('missing test listener');

		const request = httpRequest({
			host: '127.0.0.1',
			port: address.port,
			path: '/v1/machines',
			method: 'POST',
			headers: { 'content-length': '9' }
		});
		openRequests.push(request);
		const status = responseStatus(request);
		request.end();
		expect(await status).toBe(413);
		expect(routed).toBe(0);
		await waitFor(() => admission.snapshot().total === 0);
	});

	it('rejects a chunked GET before an attacker can hold an unread body', async () => {
		const admission = new PendingRequestBodyAdmission(1, 1);
		const server = createServer(controlPlaneHttpServerOptions, (request, response) => {
			const lease = admitPendingRequestBody(request, response, gatewayToken, admission);
			if (!lease) return;
			void incomingRequest(request, lease.headers, 8)
				.then(() => {
					response.statusCode = 204;
					response.end();
				})
				.catch((error: unknown) => {
					if (!(error instanceof HttpRequestError)) throw error;
					closeAfterResponse(request, response);
					response.statusCode = error.status;
					response.end();
				})
				.finally(lease.release);
		});
		openServers.push(server);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('missing test listener');

		const request = httpRequest({
			host: '127.0.0.1',
			port: address.port,
			path: '/healthz',
			method: 'GET',
			headers: { 'transfer-encoding': 'chunked' }
		});
		openRequests.push(request);
		const status = responseStatus(request);
		request.write('{');
		expect(await status).toBe(400);
		await waitFor(() => admission.snapshot().total === 0);
	});

	it('pins explicit header, body, connection, and keep-alive limits', () => {
		expect(controlPlaneHttpServerOptions).toMatchObject({
			headersTimeout: 10_000,
			requestTimeout: 30_000,
			keepAliveTimeout: 5_000,
			maxHeaderSize: 16_384,
			requireHostHeader: true
		});
	});
});
