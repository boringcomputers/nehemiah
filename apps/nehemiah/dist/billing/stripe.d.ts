import type { Database } from '../db/client.js';
export interface StripeEvent {
    readonly id: string;
    readonly type: string;
    /** Stripe's authoritative event creation time, as Unix seconds. */
    readonly created: number;
    readonly data: {
        readonly object: Record<string, unknown>;
    };
}
export declare class StripeWebhookRequestError extends Error {
    readonly code: 'invalid_stripe_signature' | 'invalid_stripe_event';
    constructor(code: 'invalid_stripe_signature' | 'invalid_stripe_event', message: string);
}
export interface StripeProcessContext {
    readonly requestId?: string;
}
export declare const verifyStripeSignature: (rawBody: string, header: string, secret: string, nowSeconds?: number, toleranceSeconds?: number) => StripeEvent;
export declare class StripeWebhookService {
    private readonly database;
    constructor(database: Database);
    process(event: StripeEvent, context?: StripeProcessContext): Promise<boolean>;
}
