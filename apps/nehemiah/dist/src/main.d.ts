import { type HealthServices } from './http/health.js';
import { Router } from './http/router.js';
import { type ApiKeyRouteServices } from './http/routes/api-keys.js';
import { type InternalRouteServices } from './http/routes/internal-hosts.js';
import { type MachineRouteServices } from './http/routes/machines.js';
export type AppServices = HealthServices & MachineRouteServices & ApiKeyRouteServices & InternalRouteServices;
export declare const buildRouter: () => Router<AppServices>;
