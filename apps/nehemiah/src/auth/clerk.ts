import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface DashboardPrincipal {
	readonly kind: 'user';
	readonly clerkUserId: string;
	readonly organizationId?: string;
	readonly claims: JWTPayload;
}

export type SessionVerifier = (token: string) => Promise<JWTPayload>;

export const clerkVerifier = (issuer: string, audience?: string): SessionVerifier => {
	const base = issuer.replace(/\/+$/, '');
	const keys = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
	return async (token) =>
		(
			await jwtVerify(token, keys, {
				issuer: base,
				audience,
				algorithms: ['RS256']
			})
		).payload;
};

export const authenticateClerkSession = async (
	token: string,
	verifySession: SessionVerifier
): Promise<DashboardPrincipal | undefined> => {
	try {
		const claims = await verifySession(token);
		if (!claims.sub) return undefined;
		const org = typeof claims.org_id === 'string' ? claims.org_id : undefined;
		return { kind: 'user', clerkUserId: claims.sub, organizationId: org, claims };
	} catch {
		return undefined;
	}
};
