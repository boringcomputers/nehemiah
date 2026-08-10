import type { Handler } from './router.js';
export interface Readiness {
    ping(): Promise<void>;
}
export interface HealthServices {
    readonly readiness: Readiness;
    readonly startedAt: Date;
}
export declare const healthz: Handler<HealthServices>;
export declare const readyz: Handler<HealthServices>;
