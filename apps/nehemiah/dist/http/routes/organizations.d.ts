import type { OrganizationService } from '../../domain/organizations.js';
import { type ProjectService } from '../../domain/projects.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface OrganizationRouteServices extends AuthServices {
    readonly organizations: OrganizationService;
    readonly projects: ProjectService;
}
export declare const registerOrganizationRoutes: <S extends OrganizationRouteServices>(router: Router<S>) => void;
