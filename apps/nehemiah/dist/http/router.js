import { AuditCompletionUnavailable } from '../audit/audit.js';
import { ApiAdmissionUnavailable, ApiRateLimitExceeded } from '../auth/api-admission.js';
import { auditHttpAuthorizationDenial } from './auth.js';
import { log, requestId, withControlPlaneRequestTelemetry } from '../telemetry.js';
export class HttpRequestError extends Error {
    status;
    code;
    detail;
    constructor(status, code, detail) {
        super(detail);
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}
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
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length < 0) {
            throw new HttpRequestError(400, 'invalid_json', 'The request body length is invalid.');
        }
        if (length > maxBytes) {
            throw new HttpRequestError(413, 'request_too_large', 'The request body is too large.');
        }
    }
    let bytes;
    try {
        if (!request.body) {
            bytes = new Uint8Array();
        }
        else {
            const reader = request.body.getReader();
            const chunks = [];
            let total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!value)
                    continue;
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel('request body limit exceeded').catch(() => undefined);
                    throw new HttpRequestError(413, 'request_too_large', 'The request body is too large.');
                }
                chunks.push(value);
            }
            bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
        }
    }
    catch (error) {
        if (error instanceof HttpRequestError)
            throw error;
        throw new HttpRequestError(400, 'invalid_json', 'The request body could not be read.');
    }
    if (bytes.byteLength > maxBytes) {
        throw new HttpRequestError(413, 'request_too_large', 'The request body is too large.');
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw new HttpRequestError(400, 'invalid_json', 'The request body is not valid JSON.');
    }
};
const match = (route, pathname) => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length !== route.segments.length)
        return undefined;
    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
        const expected = route.segments[index];
        const actual = segments[index];
        if (expected.startsWith(':')) {
            try {
                params[expected.slice(1)] = decodeURIComponent(actual);
            }
            catch {
                // A malformed percent escape is not a server failure and must never
                // reach a handler as a partially decoded identifier.
                return undefined;
            }
        }
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
        const observed = async (route, operation) => {
            const started = performance.now();
            const response = await withControlPlaneRequestTelemetry({ request, requestId: id, route }, operation);
            log('info', 'request complete', {
                requestId: id,
                method: request.method,
                path: route,
                status: response.status,
                duration_ms: performance.now() - started
            });
            return response;
        };
        for (const route of this.#routes) {
            if (route.method !== request.method)
                continue;
            const params = match(route, url.pathname);
            if (params === undefined)
                continue;
            return observed(route.path, async () => {
                try {
                    const response = await route.handler({ request, url, params, requestId: id, services });
                    await auditHttpAuthorizationDenial(request, route.path, response.status);
                    const headers = new Headers(response.headers);
                    headers.set('x-request-id', id);
                    return new Response(response.body, { status: response.status, headers });
                }
                catch (error) {
                    if (error instanceof ApiRateLimitExceeded) {
                        const response = problem(429, error.code, error.message, id, {
                            retry_after_seconds: error.retryAfterSeconds
                        });
                        const headers = new Headers(response.headers);
                        headers.set('retry-after', String(error.retryAfterSeconds));
                        headers.set('cache-control', 'no-store');
                        headers.set('x-request-id', id);
                        return new Response(response.body, { status: response.status, headers });
                    }
                    if (error instanceof ApiAdmissionUnavailable) {
                        const response = problem(503, error.code, 'API admission is temporarily unavailable.', id);
                        const headers = new Headers(response.headers);
                        headers.set('retry-after', '1');
                        headers.set('cache-control', 'no-store');
                        headers.set('x-request-id', id);
                        return new Response(response.body, { status: response.status, headers });
                    }
                    if (error instanceof HttpRequestError) {
                        return problem(error.status, error.code, error.detail, id);
                    }
                    if (error instanceof AuditCompletionUnavailable) {
                        return problem(503, 'operation_result_pending', 'The operation may have completed, but its terminal audit result is not durable. Do not retry non-idempotent work without operator confirmation.', id, { operation_may_have_completed: true });
                    }
                    return problem(500, 'internal_error', 'The request could not be completed.', id);
                }
            });
        }
        return observed('/_unmatched', async () => problem(404, 'not_found', 'No route matches this request.', id));
    }
}
//# sourceMappingURL=router.js.map