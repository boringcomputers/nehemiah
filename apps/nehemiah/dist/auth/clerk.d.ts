import { type JWTPayload } from 'jose';
export interface DashboardPrincipal {
    readonly kind: 'user';
    readonly clerkUserId: string;
    readonly organizationId?: string;
    readonly claims: JWTPayload;
}
export type SessionVerifier = (token: string) => Promise<JWTPayload>;
export declare const clerkVerifier: (issuer: string, audience?: string) => SessionVerifier;
export declare const authenticateClerkSession: (token: string, verifySession: SessionVerifier) => Promise<DashboardPrincipal | undefined>;
