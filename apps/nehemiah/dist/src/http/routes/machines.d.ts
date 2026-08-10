import type { MachineService } from '../../domain/machines.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface MachineRouteServices extends AuthServices {
    readonly machines: MachineService;
    readonly gatewaySecret: string;
    readonly gatewayPublicUrl: string;
}
export declare const registerMachineRoutes: <S extends MachineRouteServices>(router: Router<S>) => void;
