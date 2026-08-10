import { jwtVerify, SignJWT } from 'jose';
export const gatewayCapabilities = ['tty', 'vnc', 'agent', 'files', 'preview'];
const key = (secret) => new TextEncoder().encode(secret);
export const issueCapabilityToken = async (claims, secret, ttlSeconds = 300) => {
    if (ttlSeconds < 1 || ttlSeconds > 900)
        throw new Error('capability TTL must be at most 15 minutes');
    if (claims.capabilities.length === 0)
        throw new Error('at least one capability is required');
    if (claims.capabilities.some((capability) => !gatewayCapabilities.includes(capability))) {
        throw new Error('unknown gateway capability');
    }
    return new SignJWT({
        org: claims.organizationId,
        project: claims.projectId,
        cap: claims.capabilities,
        port: claims.port
    })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('nehemiah-control-plane')
        .setAudience('nehemiah-gateway')
        .setSubject(claims.machineId)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .setJti(crypto.randomUUID())
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
        !Array.isArray(payload.cap) ||
        payload.cap.some((value) => !gatewayCapabilities.includes(value))) {
        throw new Error('invalid capability claims');
    }
    return {
        machineId: payload.sub,
        organizationId: payload.org,
        projectId: payload.project,
        capabilities: payload.cap,
        port: typeof payload.port === 'number' ? payload.port : undefined
    };
};
//# sourceMappingURL=capability.js.map