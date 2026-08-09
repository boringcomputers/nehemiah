import { requestId } from '../telemetry.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestContext<S = unknown> {
	readonly request: Request;
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
	readonly requestId: string;
	readonly services: S;
}

export type Handler<S = unknown> = (context: RequestContext<S>) => Response | Promise<Response>;

interface Route<S> {
	readonly method: HttpMethod;
	readonly path: string;
	readonly segments: ReadonlyArray<string>;
	readonly handler: Handler<S>;
}

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
	});

export const problem = (
	status: number,
	code: string,
	detail: string,
	requestId?: string,
	extra: Record<string, unknown> = {}
): Response =>
	json(
		{
			type: `https://docs.boringcomputers.com/problems/${code}`,
			title: code,
			status,
			detail,
			request_id: requestId,
			...extra
		},
		status,
		{ 'content-type': 'application/problem+json' }
	);

export const readJson = async <T>(request: Request, maxBytes = 1_048_576): Promise<T> => {
	const length = Number(request.headers.get('content-length') ?? '0');
	if (length > maxBytes) throw new Error('request body is too large');
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error('request body is too large');
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
};

const match = (route: Route<unknown>, pathname: string): Record<string, string> | undefined => {
	const segments = pathname.split('/').filter(Boolean);
	if (segments.length !== route.segments.length) return undefined;
	const params: Record<string, string> = {};
	for (let index = 0; index < segments.length; index += 1) {
		const expected = route.segments[index]!;
		const actual = segments[index]!;
		if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
		else if (expected !== actual) return undefined;
	}
	return params;
};

export class Router<S> {
	readonly #routes: Array<Route<S>> = [];

	add(method: HttpMethod, path: string, handler: Handler<S>): this {
		this.#routes.push({ method, path, segments: path.split('/').filter(Boolean), handler });
		return this;
	}

	get(path: string, handler: Handler<S>): this {
		return this.add('GET', path, handler);
	}

	post(path: string, handler: Handler<S>): this {
		return this.add('POST', path, handler);
	}

	delete(path: string, handler: Handler<S>): this {
		return this.add('DELETE', path, handler);
	}

	async handle(request: Request, services: S): Promise<Response> {
		const id = requestId(request);
		const url = new URL(request.url);
		for (const route of this.#routes) {
			if (route.method !== request.method) continue;
			const params = match(route as Route<unknown>, url.pathname);
			if (params === undefined) continue;
			try {
				const response = await route.handler({ request, url, params, requestId: id, services });
				const headers = new Headers(response.headers);
				headers.set('x-request-id', id);
				return new Response(response.body, { status: response.status, headers });
			} catch (error) {
				return problem(500, 'internal_error', 'The request could not be completed.', id, {
					error: process.env.NODE_ENV === 'development' ? String(error) : undefined
				});
			}
		}
		return problem(404, 'not_found', 'No route matches this request.', id);
	}
}
