import { createRemoteJWKSet, jwtVerify } from 'jose';
export const clerkVerifier = (issuer, audience) => {
    const base = issuer.replace(/\/+$/, '');
    const keys = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    return async (token) => (await jwtVerify(token, keys, {
        issuer: base,
        audience,
        algorithms: ['RS256']
    })).payload;
};
export const authenticateClerkSession = async (token, verifySession) => {
    try {
        const claims = await verifySession(token);
        if (!claims.sub)
            return undefined;
        const org = typeof claims.org_id === 'string' ? claims.org_id : undefined;
        return { kind: 'user', clerkUserId: claims.sub, organizationId: org, claims };
    }
    catch {
        return undefined;
    }
};
//# sourceMappingURL=clerk.js.map