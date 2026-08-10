import { type VolumeService } from '../../domain/volumes.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface VolumeRouteServices extends AuthServices {
    readonly volumes: VolumeService;
}
export declare const registerVolumeRoutes: <S extends VolumeRouteServices>(router: Router<S>) => void;
