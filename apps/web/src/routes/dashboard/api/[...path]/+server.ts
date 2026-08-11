import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { controlPlaneOrigin } from '$lib/server/control-plane-origin';
import type { RequestHandler } from './$types';

const maximumBodyBytes = 1 << 20;

const boundedBody = async (request: Request): Promise<Uint8Array | undefined> => {
	if (!request.body) return undefined;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximumBodyBytes) {
			await reader.cancel();
			throw new Error('body_too_large');
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

const proxy: RequestHandler = async ({ request, params, url, fetch }) => {
	const upstream = controlPlaneOrigin(env.PRIVATE_NEHEMIAH_URL, dev);
	if (!upstream) return Response.json({ title: 'dashboard_not_configured' }, { status: 503 });
	const path = params.path ?? '';
	// Only the public API namespace is proxyable. Reject percent escapes and dot
	// segments instead of relying on URL normalization, which can turn a doubly
	// encoded dashboard path into an internal control-plane path.
	if (!/^v1(?:\/[A-Za-z0-9_-]+)*$/.test(path)) {
		return Response.json({ title: 'invalid_proxy_path' }, { status: 400 });
	}
	const authorization = request.headers.get('authorization');
	if (!authorization?.startsWith('Bearer ')) {
		return Response.json({ title: 'unauthorized' }, { status: 401 });
	}
	const headers = new Headers({ authorization, accept: 'application/json' });
	for (const name of ['content-type', 'idempotency-key', 'x-nehemiah-organization-id']) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
		return Response.json({ title: 'request_too_large' }, { status: 413 });
	}
	let body: Uint8Array | undefined;
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		try {
			body = await boundedBody(request);
		} catch {
			return Response.json({ title: 'request_too_large' }, { status: 413 });
		}
	}
	const response = await fetch(`${upstream}/${path}${url.search}`, {
		method: request.method,
		headers,
		body: body as BodyInit | undefined,
		signal: request.signal
	});
	const outgoing = new Headers();
	for (const name of [
		'content-type',
		'x-request-id',
		'retry-after',
		'ratelimit-limit',
		'ratelimit-remaining',
		'ratelimit-reset'
	]) {
		const value = response.headers.get(name);
		if (value) outgoing.set(name, value);
	}
	outgoing.set('cache-control', 'no-store');
	return new Response(response.body, { status: response.status, headers: outgoing });
};

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
