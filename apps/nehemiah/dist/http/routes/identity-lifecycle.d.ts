import type { AuditService } from '../../audit/audit.js';
import { IdentityLifecycleService } from '../../domain/identity-lifecycle.js';
import type { HostService } from '../../domain/hosts.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface IdentityLifecycleRouteServices extends AuthServices {
    readonly audit: AuditService;
    readonly hosts: HostService;
    readonly identityLifecycle: IdentityLifecycleService;
}
export declare const registerIdentityLifecycleRoutes: <S extends IdentityLifecycleRouteServices>(router: Router<S>) => void;
