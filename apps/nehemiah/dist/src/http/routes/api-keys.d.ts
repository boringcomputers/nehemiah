import type { ApiKeyService } from '../../auth/api-key.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface ApiKeyRouteServices extends AuthServices {
    readonly apiKeys: ApiKeyService;
}
export declare const registerApiKeyRoutes: <S extends ApiKeyRouteServices>(router: Router<S>) => void;
