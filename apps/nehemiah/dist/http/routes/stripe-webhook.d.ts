import { type StripeWebhookService } from '../../billing/stripe.js';
import { type Router } from '../router.js';
export interface StripeRouteServices {
    readonly stripeWebhook?: StripeWebhookService;
    readonly stripeWebhookSecret?: string;
}
export declare const registerStripeWebhookRoute: <S extends StripeRouteServices>(router: Router<S>) => void;
