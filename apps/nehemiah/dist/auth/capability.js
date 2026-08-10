import { jwtVerify, SignJWT } from 'jose';
export const gatewayCapabilities = ['tty', 'vnc', 'agent', 'files', 'preview'];
export const canonicalGatewayCapabilities = (capabilities) => gatewayCapabilities.filter((capability) => capabilities.includes(capability));
const key = (secret) => new TextEncoder().encode(secret);
export const issueCapabilityToken = async (claims, secret, ttlSeconds = 300, options = {}) => {
    if (ttlSeconds < 1 || ttlSeconds > 900)
        throw new Error('capability TTL must be at most 15 minutes');
    if (claims.capabilities.length === 0)
        throw new Error('at least one capability is required');
    const capabilities = canonicalGatewayCapabilities(claims.capabilities);
    if (capabilities.length !== claims.capabilities.length ||
        claims.capabilities.some((capability) => !gatewayCapabilities.includes(capability))) {
        throw new Error('unknown gateway capability');
    }
    const issuedAt = Math.floor((options.issuedAt ?? new Date()).getTime() / 1_000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0)
        throw new Error('invalid issued-at time');
    const capabilityId = options.capabilityId ?? crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capabilityId)) {
        throw new Error('capability ID must be a UUID');
    }
    return new SignJWT({
        org: claims.organizationId,
        project: claims.projectId,
        lease: claims.leaseId,
        cap: capabilities,
        port: claims.port
    })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('nehemiah-control-plane')
        .setAudience('nehemiah-gateway')
        .setSubject(claims.machineId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .setJti(capabilityId)
        .sign(key(secret));
};
export const verifyCapabilityToken = async (token, secret) => {
    const { payload } = await jwtVerify(token, key(secret), {
        issuer: 'nehemiah-control-plane',
        audience: 'nehemiah-gateway',
        algorithms: ['HS256']
    });
    if (!payload.sub ||
        typeof payload.org !== 'string' ||
        typeof payload.project !== 'string' ||
        typeof payload.lease !== 'string' ||
        !Array.isArray(payload.cap) ||
        payload.cap.some((value) => !gatewayCapabilities.includes(value))) {
        throw new Error('invalid capability claims');
    }
    return {
        machineId: payload.sub,
        organizationId: payload.org,
        projectId: payload.project,
        leaseId: payload.lease,
        capabilities: payload.cap,
        port: typeof payload.port === 'number' ? payload.port : undefined
    };
};
//# sourceMappingURL=capability.js.map