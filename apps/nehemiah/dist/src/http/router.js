import { requestId } from '../telemetry.js';
export const json = (body, status = 200, headers) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});
export const problem = (status, code, detail, requestId, extra = {}) => json({
    type: `https://docs.boringcomputers.com/problems/${code}`,
    title: code,
    status,
    detail,
    request_id: requestId,
    ...extra
}, status, { 'content-type': 'application/problem+json' });
export const readJson = async (request, maxBytes = 1_048_576) => {
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > maxBytes)
        throw new Error('request body is too large');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes)
        throw new Error('request body is too large');
    return JSON.parse(new TextDecoder().decode(bytes));
};
const match = (route, pathname) => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== route.segments.length)
        return undefined;
    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
        const expected = route.segments[index];
        const actual = segments[index];
        if (expected.startsWith(':'))
            params[expected.slice(1)] = decodeURIComponent(actual);
        else if (expected !== actual)
            return undefined;
    }
    return params;
};
export class Router {
    #routes = [];
    add(method, path, handler) {
        this.#routes.push({ method, path, segments: path.split('/').filter(Boolean), handler });
        return this;
    }
    get(path, handler) {
        return this.add('GET', path, handler);
    }
    post(path, handler) {
        return this.add('POST', path, handler);
    }
    delete(path, handler) {
        return this.add('DELETE', path, handler);
    }
    async handle(request, services) {
        const id = requestId(request);
        const url = new URL(request.url);
        for (const route of this.#routes) {
            if (route.method !== request.method)
                continue;
            const params = match(route, url.pathname);
            if (params === undefined)
                continue;
            try {
                const response = await route.handler({ request, url, params, requestId: id, services });
                const headers = new Headers(response.headers);
                headers.set('x-request-id', id);
                return new Response(response.body, { status: response.status, headers });
            }
            catch (error) {
                return problem(500, 'internal_error', 'The request could not be completed.', id, {
                    error: process.env.NODE_ENV === 'development' ? String(error) : undefined
                });
            }
        }
        return problem(404, 'not_found', 'No route matches this request.', id);
    }
}
//# sourceMappingURL=router.js.map