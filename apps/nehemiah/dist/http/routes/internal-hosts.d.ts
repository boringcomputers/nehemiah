import type { AuditService } from '../../audit/audit.js';
import { type AuthoritativeMetering } from '../../billing/metering.js';
import { type HostService } from '../../domain/hosts.js';
import { type StreamAdmissionService } from '../../domain/stream-admission.js';
import type { Queryable } from '../../db/client.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface InternalRouteServices extends AuthServices {
    readonly audit: AuditService;
    readonly database: Queryable;
    readonly hosts: HostService;
    readonly metering?: AuthoritativeMetering;
    readonly streamAdmission?: StreamAdmissionService;
    readonly gatewayToken: string;
}
export declare const registerInternalHostRoutes: <S extends InternalRouteServices>(router: Router<S>) => void;
