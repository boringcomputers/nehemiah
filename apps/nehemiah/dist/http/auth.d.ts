import { type ApiKeyPrincipal, type ApiKeyScope, type ApiKeyService } from '../auth/api-key.js';
import { type ApiAdmission } from '../auth/api-admission.js';
import type { DashboardPrincipal, SessionVerifier } from '../auth/clerk.js';
import type { DeviceAuthorizationService } from '../auth/device.js';
import type { AuditService } from '../audit/audit.js';
import type { OrganizationService } from '../domain/organizations.js';
import type { MembershipRole } from '../domain/organizations.js';
export type Principal = ApiKeyPrincipal | (DashboardPrincipal & {
    readonly organizationId: string;
    readonly role: MembershipRole;
});
export interface AuthServices {
    readonly apiKeys: ApiKeyService;
    readonly audit: AuditService;
    readonly organizations: OrganizationService;
    readonly clerkSessionVerifier?: SessionVerifier;
    readonly deviceAuthorizations?: DeviceAuthorizationService;
    readonly apiAdmission?: ApiAdmission;
}
export declare const authenticateIdentity: (request: Request, services: AuthServices) => Promise<ApiKeyPrincipal | DashboardPrincipal | undefined>;
export declare const authenticate: (request: Request, services: AuthServices) => Promise<Principal | undefined>;
/** Called by the router after a deliberately coarse 403/404 response. */
export declare const auditHttpAuthorizationDenial: (request: Request, route: string, status: number) => Promise<void>;
export declare const projectFor: (principal: Principal, requested?: string) => string | undefined;
export declare const permits: (principal: Principal, scope: ApiKeyScope) => boolean;
export declare const canAdminister: (principal: Principal) => boolean;
