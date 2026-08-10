import type { Queryable } from '../db/client.js';
import { type Rate } from './rates.js';
export interface BillingCommitmentDelta {
    /** Whole vCPU-seconds reserved by the new operation. */
    readonly vcpuSeconds?: bigint;
    /** Whole MiB-seconds reserved by the new operation. */
    readonly memoryMebibyteSeconds?: bigint;
    /** Whole byte-seconds reserved by the new operation. */
    readonly storageByteSeconds?: bigint;
}
export declare class BillingAdmissionRejected extends Error {
    readonly code: 'billing_delinquent' | 'billing_plan_unavailable' | 'spend_cap_exceeded';
    constructor(code: 'billing_delinquent' | 'billing_plan_unavailable' | 'spend_cap_exceeded', message: string);
}
/**
 * Admission-time cost projection over immutable usage plus durable, unexpired
 * allocations. This is deliberately more conservative than invoice pricing:
 * every dimension is rounded up to a micro-dollar before comparing the cap.
 *
 * Callers must hold the organization row lock before invoking this method. The
 * Stripe transition path uses the same organization -> billing-account order,
 * making delinquency and commitment admission one serial decision per tenant.
 */
export declare class BillingAdmissionPolicy {
    #private;
    private readonly plan;
    constructor(rates?: ReadonlyArray<Rate>, plan?: string);
    enforce(client: Queryable, organizationId: string, additional?: BillingCommitmentDelta): Promise<void>;
}
