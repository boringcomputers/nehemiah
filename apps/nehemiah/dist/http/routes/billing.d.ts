import type { Database } from '../../db/client.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface BillingRouteServices extends AuthServices {
    readonly database: Database;
}
export declare const registerBillingRoutes: <S extends BillingRouteServices>(router: Router<S>) => void;
