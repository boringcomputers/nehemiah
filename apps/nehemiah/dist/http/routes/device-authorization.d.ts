import { type ApiKeyScope } from '../../auth/api-key.js';
import { type DeviceAuthorizationService } from '../../auth/device.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface DeviceAuthorizationRouteServices extends AuthServices {
    readonly deviceAuthorizations: DeviceAuthorizationService;
}
export declare const registerDeviceAuthorizationRoutes: <S extends DeviceAuthorizationRouteServices>(router: Router<S>) => void;
export declare const defaultDeviceScopes: ReadonlyArray<ApiKeyScope>;
