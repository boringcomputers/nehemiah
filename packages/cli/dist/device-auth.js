import { execFile } from 'node:child_process';
export const cliDeviceScopes = [
    'machines:read',
    'machines:write',
    'templates:read',
    'templates:write',
    'volumes:read',
    'volumes:write'
];
export class DeviceAuthError extends Error {
    code;
    status;
    retryAfterSeconds;
    constructor(code, message, options = {}) {
        super(message);
        this.code = code;
        this.status = options.status;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}
const maximumResponseBytes = 65_536;
const defaultRequestTimeoutMs = 15_000;
const supportedScopes = new Set([...cliDeviceScopes, 'billing:read']);
const uuidSource = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuidSource}$`, 'i');
const userCodePattern = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const opaquePattern = (kind) => new RegExp(`^bc_${kind}_${uuidSource}_[A-Za-z0-9_-]{43}$`, 'i');
const isLoopback = (url) => loopbackHostnames.has(url.hostname);
const hasSafeProtocol = (url) => url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url));
const endpoint = (baseUrl, path) => {
    const base = new URL(baseUrl);
    if (base.username ||
        base.password ||
        base.pathname !== '/' ||
        base.search ||
        base.hash ||
        !hasSafeProtocol(base)) {
        throw new DeviceAuthError('unsafe_auth_endpoint', 'Device login requires a trusted HTTPS API URL.');
    }
    base.pathname = path;
    return base.toString();
};
const responseJson = async (response, signal) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximumResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new DeviceAuthError('invalid_response', 'The device-login response was too large.');
    }
    if (!response.body)
        return {};
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    if (signal.aborted)
        cancel();
    else
        signal.addEventListener('abort', cancel, { once: true });
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > maximumResponseBytes) {
                await reader.cancel().catch(() => undefined);
                throw new DeviceAuthError('invalid_response', 'The device-login response was too large.');
            }
            chunks.push(value);
        }
    }
    finally {
        signal.removeEventListener('abort', cancel);
    }
    if (total === 0)
        return {};
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw new DeviceAuthError('invalid_response', 'The device-login response was not valid JSON.');
    }
};
const post = async (baseUrl, path, body, fetchImplementation, options = {}) => {
    const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new DeviceAuthError('invalid_request', 'The device-login request timeout is invalid.');
    }
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(new DeviceAuthError('request_timeout', 'The device-login request timed out.'));
            }, timeoutMs);
        });
        const operation = (async () => {
            const response = await fetchImplementation(endpoint(baseUrl, path), {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            const value = response.status === 204 ? {} : await responseJson(response, controller.signal);
            return { response, value };
        })();
        return await Promise.race([operation, timeout]);
    }
    catch (error) {
        if (timedOut) {
            throw new DeviceAuthError('request_timeout', 'The device-login request timed out.');
        }
        if (error instanceof DeviceAuthError)
            throw error;
        throw new DeviceAuthError('request_error', 'Could not reach the device-login endpoint.');
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
};
const failure = (response, value) => {
    const code = (typeof value.error === 'string' && value.error) ||
        (typeof value.title === 'string' && value.title) ||
        'device_auth_failed';
    const detail = typeof value.detail === 'string'
        ? value.detail
        : `Device authorization failed (${response.status}).`;
    const retryHeader = Number(response.headers.get('retry-after'));
    const retryBody = Number(value.interval);
    const retryAfterSeconds = Number.isFinite(retryHeader)
        ? retryHeader
        : Number.isFinite(retryBody)
            ? retryBody
            : undefined;
    return new DeviceAuthError(code, detail, { status: response.status, retryAfterSeconds });
};
const string = (value) => typeof value === 'string' && value.length > 0 ? value : undefined;
const positiveInteger = (value) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
const validVerificationUrls = (baseUrl, verification, complete, userCode) => {
    try {
        const api = new URL(baseUrl);
        const basic = new URL(verification);
        const withCode = new URL(complete);
        // Production permits either the API origin itself or one exact deployment
        // relation: api.<dashboard-host> -> <dashboard-host>. Development may use
        // different ports/names for two loopback services. Arbitrary parent-domain
        // suffixes are deliberately rejected (for example, a public suffix).
        const trustedOriginRelation = api.origin === basic.origin ||
            (isLoopback(api) && isLoopback(basic)) ||
            (api.protocol === 'https:' &&
                !api.port &&
                basic.protocol === 'https:' &&
                !basic.port &&
                api.hostname === `api.${basic.hostname}`);
        return (hasSafeProtocol(api) &&
            hasSafeProtocol(basic) &&
            hasSafeProtocol(withCode) &&
            !api.username &&
            !api.password &&
            !api.search &&
            !api.hash &&
            !basic.username &&
            !basic.password &&
            !basic.search &&
            !basic.hash &&
            !withCode.username &&
            !withCode.password &&
            !withCode.hash &&
            basic.origin === withCode.origin &&
            trustedOriginRelation &&
            basic.pathname === withCode.pathname &&
            withCode.searchParams.getAll('user_code').length === 1 &&
            withCode.searchParams.get('user_code') === userCode &&
            [...withCode.searchParams.keys()].every((key) => key === 'user_code'));
    }
    catch {
        return false;
    }
};
const parseToken = (value) => {
    const token = {
        token_type: value.token_type,
        access_token: string(value.access_token),
        expires_in: positiveInteger(value.expires_in),
        refresh_token: string(value.refresh_token),
        refresh_expires_in: positiveInteger(value.refresh_expires_in),
        organization_id: string(value.organization_id),
        project_id: string(value.project_id),
        scopes: Array.isArray(value.scopes)
            ? value.scopes.filter((scope) => typeof scope === 'string')
            : []
    };
    if (token.token_type !== 'Bearer' ||
        !token.access_token ||
        !opaquePattern('access').test(token.access_token) ||
        !token.refresh_token ||
        !opaquePattern('refresh').test(token.refresh_token) ||
        !token.expires_in ||
        token.expires_in > 900 ||
        !token.refresh_expires_in ||
        token.refresh_expires_in > 2_592_000 ||
        !token.organization_id ||
        !uuidPattern.test(token.organization_id) ||
        !token.project_id ||
        !uuidPattern.test(token.project_id) ||
        token.scopes.length === 0 ||
        token.scopes.length > supportedScopes.size ||
        new Set(token.scopes).size !== token.scopes.length ||
        token.scopes.some((scope) => !supportedScopes.has(scope))) {
        throw new DeviceAuthError('invalid_response', 'The device-login token response was invalid.');
    }
    return token;
};
export async function requestDeviceCode(baseUrl, scopes, fetchImplementation, options = {}) {
    if (scopes.length === 0 ||
        scopes.length > supportedScopes.size ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !supportedScopes.has(scope))) {
        throw new DeviceAuthError('invalid_request', 'The requested device-login scopes are invalid.');
    }
    const { response, value } = await post(baseUrl, '/v1/auth/device/code', { client_id: 'nehemiah-cli', scopes }, fetchImplementation, options);
    if (!response.ok)
        throw failure(response, value);
    const parsed = {
        device_code: string(value.device_code),
        user_code: string(value.user_code),
        verification_uri: string(value.verification_uri),
        verification_uri_complete: string(value.verification_uri_complete),
        expires_in: positiveInteger(value.expires_in),
        interval: positiveInteger(value.interval),
        scopes: Array.isArray(value.scopes)
            ? value.scopes.filter((scope) => typeof scope === 'string')
            : []
    };
    if (!parsed.device_code ||
        !opaquePattern('device').test(parsed.device_code) ||
        !parsed.user_code ||
        !userCodePattern.test(parsed.user_code) ||
        !parsed.verification_uri ||
        !parsed.verification_uri_complete ||
        !parsed.expires_in ||
        parsed.expires_in > 600 ||
        !parsed.interval ||
        parsed.interval < 5 ||
        parsed.interval > 60 ||
        parsed.scopes.length === 0 ||
        parsed.scopes.length !== scopes.length ||
        new Set(parsed.scopes).size !== parsed.scopes.length ||
        parsed.scopes.some((scope) => !supportedScopes.has(scope) || !scopes.includes(scope))) {
        throw new DeviceAuthError('invalid_response', 'The device-login response was invalid.');
    }
    if (!validVerificationUrls(baseUrl, parsed.verification_uri, parsed.verification_uri_complete, parsed.user_code)) {
        throw new DeviceAuthError('invalid_response', 'The verification URL was not safe to open.');
    }
    return parsed;
}
export async function exchangeDeviceCode(baseUrl, deviceCode, fetchImplementation, options = {}) {
    const { response, value } = await post(baseUrl, '/v1/auth/device/token', { device_code: deviceCode }, fetchImplementation, options);
    if (!response.ok)
        throw failure(response, value);
    return parseToken(value);
}
export async function refreshDeviceToken(baseUrl, refreshToken, fetchImplementation, options = {}) {
    const { response, value } = await post(baseUrl, '/v1/auth/device/refresh', { refresh_token: refreshToken }, fetchImplementation, options);
    if (!response.ok)
        throw failure(response, value);
    return parseToken(value);
}
export async function revokeDeviceToken(baseUrl, refreshToken, fetchImplementation, options = {}) {
    const { response, value } = await post(baseUrl, '/v1/auth/device/revoke', { refresh_token: refreshToken }, fetchImplementation, options);
    if (!response.ok)
        throw failure(response, value);
}
export async function pollDeviceToken(input) {
    const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const now = input.now ?? Date.now;
    const deadline = now() + input.code.expires_in * 1_000;
    let intervalSeconds = input.code.interval;
    for (;;) {
        if (now() + intervalSeconds * 1_000 > deadline) {
            throw new DeviceAuthError('expired_token', 'The device authorization expired before approval.');
        }
        await sleep(intervalSeconds * 1_000);
        try {
            const token = await exchangeDeviceCode(input.baseUrl, input.code.device_code, input.fetch, {
                timeoutMs: Math.min(input.requestTimeoutMs ?? defaultRequestTimeoutMs, Math.max(1, deadline - now()))
            });
            if (token.scopes.some((scope) => !input.code.scopes.includes(scope))) {
                throw new DeviceAuthError('invalid_response', 'The device-login token exceeded the requested scopes.');
            }
            return token;
        }
        catch (error) {
            if (!(error instanceof DeviceAuthError))
                throw error;
            if (error.code === 'authorization_pending') {
                intervalSeconds = Math.max(intervalSeconds, error.retryAfterSeconds ?? intervalSeconds);
                continue;
            }
            if (error.code === 'slow_down') {
                intervalSeconds = Math.max(intervalSeconds + 5, error.retryAfterSeconds ?? 0);
                continue;
            }
            throw error;
        }
    }
}
export const openVerificationPage = async (url, baseUrl, platform = process.platform) => {
    let validated;
    try {
        const complete = new URL(url);
        const code = complete.searchParams.get('user_code') ?? '';
        const basic = new URL(url);
        basic.search = '';
        if (!userCodePattern.test(code) ||
            !validVerificationUrls(baseUrl, basic.toString(), url, code)) {
            throw new Error('unsafe verification URL');
        }
        validated = complete.toString();
    }
    catch {
        throw new DeviceAuthError('invalid_response', 'The verification URL was not safe to open.');
    }
    return new Promise((resolve, reject) => {
        const command = platform === 'darwin'
            ? { file: 'open', args: [validated] }
            : platform === 'win32'
                ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', validated] }
                : { file: 'xdg-open', args: [validated] };
        const child = execFile(command.file, command.args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
        child.unref();
    });
};
//# sourceMappingURL=device-auth.js.map