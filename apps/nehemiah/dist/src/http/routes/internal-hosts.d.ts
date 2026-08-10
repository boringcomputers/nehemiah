import type { HostService } from '../../domain/hosts.js';
import type { Queryable } from '../../db/client.js';
import { type Router } from '../router.js';
export interface InternalRouteServices {
    readonly database: Queryable;
    readonly hosts: HostService;
    readonly internalToken: string;
    readonly gatewayToken: string;
}
export declare const registerInternalHostRoutes: <S extends InternalRouteServices>(router: Router<S>) => void;
