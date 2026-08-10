import { StripeWebhookRequestError, verifyStripeSignature } from '../../billing/stripe.js';
import { json, problem } from '../router.js';
export const registerStripeWebhookRoute = (router) => {
    router.post('/v1/webhooks/stripe', async ({ request, services, requestId }) => {
        if (!services.stripeWebhook || !services.stripeWebhookSecret) {
            return problem(503, 'billing_disabled', 'Stripe billing is not configured.', requestId);
        }
        const rawBody = await request.text();
        let event;
        try {
            event = verifyStripeSignature(rawBody, request.headers.get('stripe-signature') ?? '', services.stripeWebhookSecret);
        }
        catch (error) {
            if (error instanceof StripeWebhookRequestError) {
                return problem(400, error.code, error.message, requestId);
            }
            throw error;
        }
        try {
            const processed = await services.stripeWebhook.process(event, { requestId });
            return json({ received: true, replayed: !processed });
        }
        catch {
            return problem(500, 'stripe_processing_failed', 'Stripe webhook processing could not be completed.', requestId);
        }
    });
};
//# sourceMappingURL=stripe-webhook.js.map