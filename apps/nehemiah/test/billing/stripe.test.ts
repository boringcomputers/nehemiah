import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	StripeWebhookRequestError,
	verifyStripeSignature,
	type StripeWebhookService
} from '../../src/billing/stripe.js';
import { registerStripeWebhookRoute } from '../../src/http/routes/stripe-webhook.js';
import { Router } from '../../src/http/router.js';

const signed = (body: string, secret: string, timestamp = Math.floor(Date.now() / 1_000)): string =>
	`t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

describe('Stripe webhook verification', () => {
	it('verifies the exact raw request and timestamp', () => {
		const body = JSON.stringify({
			id: 'evt_1',
			type: 'invoice.paid',
			created: 1_699_999_999,
			data: { object: { id: 'in_1', customer: 'cus_1' } }
		});
		const timestamp = 1_700_000_000;
		const secret = 'whsec_test';
		const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
		const event = verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret, timestamp);
		expect(event.id).toBe('evt_1');
		expect(() =>
			verifyStripeSignature(`${body} `, `t=${timestamp},v1=${signature}`, secret, timestamp)
		).toThrow(StripeWebhookRequestError);
		try {
			verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret, timestamp + 301);
			expect.fail('expired signatures must be rejected');
		} catch (error) {
			expect(error).toMatchObject({ code: 'invalid_stripe_signature' });
		}
	});

	it('rejects signed events that omit or corrupt Stripe source ordering', () => {
		const timestamp = 1_700_000_000;
		const secret = 'whsec_test';
		for (const created of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
			const body = JSON.stringify({
				id: 'evt_invalid_created',
				type: 'invoice.paid',
				...(created === undefined ? {} : { created }),
				data: { object: { id: 'in_invalid', customer: 'cus_1' } }
			});
			expect(() =>
				verifyStripeSignature(body, signed(body, secret, timestamp), secret, timestamp)
			).toThrow(StripeWebhookRequestError);
		}
	});

	it('rejects signed invoice events without bounded invoice and customer identity', () => {
		const timestamp = 1_700_000_000;
		const secret = 'whsec_test';
		for (const object of [
			{ customer: 'cus_1' },
			{ id: 'in_1' },
			{ id: '', customer: 'cus_1' },
			{ id: 'in_1', customer: '' }
		]) {
			const body = JSON.stringify({
				id: 'evt_invalid_invoice',
				type: 'invoice.payment_failed',
				created: timestamp,
				data: { object }
			});
			expect(() =>
				verifyStripeSignature(body, signed(body, secret, timestamp), secret, timestamp)
			).toThrow(StripeWebhookRequestError);
		}
	});

	it('returns typed 400 validation failures and never invokes processing', async () => {
		const process = vi.fn();
		const router = new Router<{
			stripeWebhook: StripeWebhookService;
			stripeWebhookSecret: string;
		}>();
		registerStripeWebhookRoute(router);
		const response = await router.handle(
			new Request('https://api.example.test/v1/webhooks/stripe', {
				method: 'POST',
				headers: { 'stripe-signature': 't=1,v1=invalid' },
				body: '{}'
			}),
			{
				stripeWebhook: { process } as unknown as StripeWebhookService,
				stripeWebhookSecret: 'whsec_test'
			}
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			status: 400,
			title: 'invalid_stripe_signature'
		});
		expect(process).not.toHaveBeenCalled();
	});

	it('returns a generic 5xx when durable processing fails', async () => {
		const secret = 'whsec_test';
		const body = JSON.stringify({
			id: 'evt_database_failure',
			type: 'invoice.paid',
			created: Math.floor(Date.now() / 1_000),
			data: { object: { id: 'in_database_failure', customer: 'cus_1' } }
		});
		const process = vi
			.fn()
			.mockRejectedValue(new Error('password=secret relation billing missing'));
		const router = new Router<{
			stripeWebhook: StripeWebhookService;
			stripeWebhookSecret: string;
		}>();
		registerStripeWebhookRoute(router);
		const response = await router.handle(
			new Request('https://api.example.test/v1/webhooks/stripe', {
				method: 'POST',
				headers: { 'stripe-signature': signed(body, secret) },
				body
			}),
			{
				stripeWebhook: { process } as unknown as StripeWebhookService,
				stripeWebhookSecret: secret
			}
		);
		const problem = await response.text();
		expect(response.status).toBe(500);
		expect(problem).toContain('stripe_processing_failed');
		expect(problem).not.toContain('password=secret');
		expect(problem).not.toContain('relation billing');
	});
});
