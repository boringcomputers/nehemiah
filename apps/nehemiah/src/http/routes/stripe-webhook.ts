import {
	StripeWebhookRequestError,
	verifyStripeSignature,
	type StripeWebhookService
} from '../../billing/stripe.js';
import { json, problem, type Router } from '../router.js';

export interface StripeRouteServices {
	readonly stripeWebhook?: StripeWebhookService;
	readonly stripeWebhookSecret?: string;
}

export const registerStripeWebhookRoute = <S extends StripeRouteServices>(
	router: Router<S>
): void => {
	router.post('/v1/webhooks/stripe', async ({ request, services, requestId }) => {
		if (!services.stripeWebhook || !services.stripeWebhookSecret) {
			return problem(503, 'billing_disabled', 'Stripe billing is not configured.', requestId);
		}
		const rawBody = await request.text();
		let event;
		try {
			event = verifyStripeSignature(
				rawBody,
				request.headers.get('stripe-signature') ?? '',
				services.stripeWebhookSecret
			);
		} catch (error) {
			if (error instanceof StripeWebhookRequestError) {
				return problem(400, error.code, error.message, requestId);
			}
			throw error;
		}
		try {
			const processed = await services.stripeWebhook.process(event, { requestId });
			return json({ received: true, replayed: !processed });
		} catch {
			return problem(
				500,
				'stripe_processing_failed',
				'Stripe webhook processing could not be completed.',
				requestId
			);
		}
	});
};
