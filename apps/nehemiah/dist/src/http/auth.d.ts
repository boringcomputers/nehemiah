import type { ApiKeyPrincipal, ApiKeyScope, ApiKeyService } from '../auth/api-key.js';
import type { DashboardPrincipal, SessionVerifier } from '../auth/clerk.js';
import type { OrganizationService } from '../domain/organizations.js';
export type Principal = ApiKeyPrincipal | (DashboardPrincipal & {
    readonly organizationId: string;
});
export interface AuthServices {
    readonly apiKeys: ApiKeyService;
    readonly organizations: OrganizationService;
    readonly clerkSessionVerifier?: SessionVerifier;
}
export declare const authenticate: (request: Request, services: AuthServices) => Promise<Principal | undefined>;
export declare const projectFor: (principal: Principal, requested?: string) => string | undefined;
export declare const permits: (principal: Principal, scope: ApiKeyScope) => boolean;
