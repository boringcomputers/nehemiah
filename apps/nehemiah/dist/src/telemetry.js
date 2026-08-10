import { randomUUID } from 'node:crypto';
export const requestId = (request) => {
    const supplied = request.headers.get('x-request-id');
    return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
};
/** Structured logger with an allowlist: command bodies, terminal bytes and secrets never enter it. */
export const log = (level, message, context = {}) => {
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context })}\n`);
};
//# sourceMappingURL=telemetry.js.map