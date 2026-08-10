import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Router } from '../../src/http/router.js';

export interface TestHttpServer {
	readonly origin: string;
	close(): Promise<void>;
}

const toRequest = async (incoming: IncomingMessage, origin: string): Promise<Request> => {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
		else if (value !== undefined) headers.set(name, value);
	}

	const chunks: Buffer[] = [];
	for await (const chunk of incoming) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

	return new Request(`${origin}${incoming.url ?? '/'}`, {
		method: incoming.method,
		headers,
		body
	});
};

const close = async (server: Server): Promise<void> => {
	server.closeAllConnections();
	server.close();
	await once(server, 'close');
};

/** Exercise the fetch-facing router through a real loopback TCP HTTP server. */
export const listenRouter = async <Services>(
	router: Router<Services>,
	services: Services
): Promise<TestHttpServer> => {
	let origin = '';
	const server = createServer(async (incoming, outgoing) => {
		try {
			const response = await router.handle(await toRequest(incoming, origin), services);
			outgoing.statusCode = response.status;
			response.headers.forEach((value, name) => outgoing.setHeader(name, value));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			outgoing.statusCode = 500;
			outgoing.setHeader('content-type', 'application/problem+json');
			outgoing.end(JSON.stringify({ title: 'test_http_server_error', status: 500 }));
		}
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
	return { origin, close: () => close(server) };
};
