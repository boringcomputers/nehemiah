import { createHmac, timingSafeEqual } from 'node:crypto';
export class StripeWebhookRequestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const signatureValues = (header) => {
    let timestamp = 0;
    const signatures = [];
    for (const part of header.split(',')) {
        const [name, value] = part.split('=', 2);
        if (name === 't')
            timestamp = Number(value);
        if (name === 'v1' && value)
            signatures.push(value);
    }
    return { timestamp, signatures };
};
export const verifyStripeSignature = (rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1_000), toleranceSeconds = 300) => {
    const { timestamp, signatures } = signatureValues(header);
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
        throw new StripeWebhookRequestError('invalid_stripe_signature', 'Stripe webhook signature is invalid or expired.');
    }
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    const valid = signatures.some((signature) => {
        if (!/^[0-9a-f]{64}$/i.test(signature))
            return false;
        const candidate = Buffer.from(signature, 'hex');
        return candidate.length === expectedBytes.length && timingSafeEqual(candidate, expectedBytes);
    });
    if (!valid) {
        throw new StripeWebhookRequestError('invalid_stripe_signature', 'Stripe webhook signature is invalid or expired.');
    }
    let candidate;
    try {
        candidate = JSON.parse(rawBody);
    }
    catch {
        throw new StripeWebhookRequestError('invalid_stripe_event', 'Stripe event payload is malformed.');
    }
    const eventId = typeof candidate === 'object' && candidate !== null ? Reflect.get(candidate, 'id') : undefined;
    const eventType = typeof candidate === 'object' && candidate !== null
        ? Reflect.get(candidate, 'type')
        : undefined;
    const eventCreated = typeof candidate === 'object' && candidate !== null
        ? Reflect.get(candidate, 'created')
        : undefined;
    const eventCreatedAt = typeof eventCreated === 'number' ? new Date(eventCreated * 1_000) : undefined;
    if (typeof candidate !== 'object' ||
        candidate === null ||
        Array.isArray(candidate) ||
        typeof eventId !== 'string' ||
        eventId.length < 1 ||
        eventId.length > 255 ||
        typeof eventType !== 'string' ||
        eventType.length < 1 ||
        eventType.length > 255 ||
        !Number.isSafeInteger(eventCreated) ||
        eventCreated < 0 ||
        !eventCreatedAt ||
        !Number.isFinite(eventCreatedAt.getTime())) {
        throw new StripeWebhookRequestError('invalid_stripe_event', 'Stripe event payload is malformed.');
    }
    const data = Reflect.get(candidate, 'data');
    const object = typeof data === 'object' && data !== null ? Reflect.get(data, 'object') : undefined;
    if (typeof object !== 'object' || object === null || Array.isArray(object)) {
        throw new StripeWebhookRequestError('invalid_stripe_event', 'Stripe event payload is malformed.');
    }
    if (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed') {
        const invoiceId = Reflect.get(object, 'id');
        const customer = Reflect.get(object, 'customer');
        if (typeof invoiceId !== 'string' ||
            invoiceId.length < 1 ||
            invoiceId.length > 255 ||
            typeof customer !== 'string' ||
            customer.length < 1 ||
            customer.length > 255) {
            throw new StripeWebhookRequestError('invalid_stripe_event', 'Stripe invoice event identity is malformed.');
        }
    }
    return candidate;
};
export class StripeWebhookService {
    database;
    constructor(database) {
        this.database = database;
    }
    async process(event, context = {}) {
        return this.database.transaction(async (client) => {
            const inserted = await client.query(`INSERT INTO stripe_events (id, event_type, stripe_created_at, payload)
				 VALUES ($1, $2, to_timestamp($3), $4) ON CONFLICT (id) DO NOTHING`, [event.id, event.type, event.created, event]);
            if (!inserted.rowCount)
                return false;
            const customer = event.data.object.customer;
            const invoiceId = event.data.object.id;
            const targetDelinquent = event.type === 'invoice.payment_failed'
                ? true
                : event.type === 'invoice.paid'
                    ? false
                    : undefined;
            if (typeof customer === 'string' &&
                typeof invoiceId === 'string' &&
                targetDelinquent !== undefined) {
                const lookup = await client.query('SELECT organization_id FROM billing_accounts WHERE stripe_customer_id = $1', [customer]);
                const organizationId = lookup.rows[0]?.organization_id;
                if (!organizationId) {
                    // Roll the receipt insert back so Stripe retries after an account-link
                    // race instead of permanently consuming an unmatched invoice event.
                    throw new Error('Stripe invoice customer is not linked to a billing account.');
                }
                {
                    // Admission paths use the same organization -> billing-account lock
                    // order, so a webhook transition cannot race a new commitment.
                    const organization = await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
                    if (organization.rows[0]) {
                        const account = await client.query(`SELECT organization_id, delinquent_at FROM billing_accounts
							 WHERE organization_id = $1 AND stripe_customer_id = $2 FOR UPDATE`, [organizationId, customer]);
                        const prior = account.rows[0];
                        if (prior) {
                            const invoice = await client.query(`SELECT failed, stripe_event_created_at, stripe_event_rank, stripe_event_id
								 FROM stripe_invoice_delinquency
								 WHERE organization_id = $1 AND stripe_invoice_id = $2 FOR UPDATE`, [organizationId, invoiceId]);
                            const eventCreatedAt = new Date(event.created * 1_000);
                            // A payment failure dominates a paid event created in the same
                            // second. This is deterministic and deliberately fail-closed when
                            // Stripe's second-resolution timestamp cannot establish causality.
                            const eventRank = targetDelinquent ? 1 : 0;
                            const priorInvoice = invoice.rows[0];
                            const invoiceStateChanged = !priorInvoice || priorInvoice.failed !== targetDelinquent;
                            const priorCreatedAt = priorInvoice?.stripe_event_created_at;
                            const priorRank = priorInvoice?.stripe_event_rank;
                            const priorId = priorInvoice?.stripe_event_id;
                            const newer = !priorCreatedAt ||
                                eventCreatedAt > priorCreatedAt ||
                                (eventCreatedAt.getTime() === priorCreatedAt.getTime() &&
                                    (eventRank > (priorRank ?? -1) ||
                                        (eventRank === priorRank && event.id > (priorId ?? ''))));
                            if (!newer) {
                                await client.query(`INSERT INTO audit_events
									 (event_key, organization_id, actor_type, actor_id, action, outcome,
									  resource_type, resource_id, request_id, metadata)
									 VALUES ($1, $2::uuid, 'system', 'stripe',
									         'billing.delinquency_event_ignored', 'succeeded',
									         'billing_account', $2::uuid::text, $3, $4)`, [
                                    `stripe:${event.id}:stale-delinquency`,
                                    organizationId,
                                    context.requestId ?? null,
                                    {
                                        stripe_event_id: event.id,
                                        event_type: event.type,
                                        event_created: event.created,
                                        stripe_invoice_id: invoiceId,
                                        reason: 'stale_source_order',
                                        last_applied_event_id: priorId,
                                        last_applied_event_created: priorCreatedAt?.toISOString()
                                    }
                                ]);
                            }
                            else {
                                await client.query(`INSERT INTO stripe_invoice_delinquency
									 (organization_id, stripe_invoice_id, failed, stripe_event_created_at,
									  stripe_event_rank, stripe_event_id, updated_at)
									 VALUES ($1, $2, $3, to_timestamp($4), $5, $6, now())
									 ON CONFLICT (organization_id, stripe_invoice_id) DO UPDATE
									 SET failed = EXCLUDED.failed,
									     stripe_event_created_at = EXCLUDED.stripe_event_created_at,
									     stripe_event_rank = EXCLUDED.stripe_event_rank,
									     stripe_event_id = EXCLUDED.stripe_event_id,
									     updated_at = now()`, [organizationId, invoiceId, targetDelinquent, event.created, eventRank, event.id]);
                                if (invoiceStateChanged) {
                                    await client.query(`INSERT INTO audit_events
										 (event_key, organization_id, actor_type, actor_id, action, outcome,
										  resource_type, resource_id, request_id, metadata)
										 VALUES ($1, $2::uuid, 'system', 'stripe',
										         'billing.invoice_delinquency_changed', 'succeeded',
										         'stripe_invoice', $3, $4, $5)`, [
                                        `stripe:${event.id}:invoice-delinquency`,
                                        organizationId,
                                        invoiceId,
                                        context.requestId ?? null,
                                        {
                                            stripe_event_id: event.id,
                                            event_type: event.type,
                                            event_created: event.created,
                                            prior_state: priorInvoice
                                                ? priorInvoice.failed
                                                    ? 'delinquent'
                                                    : 'current'
                                                : 'unknown',
                                            state: targetDelinquent ? 'delinquent' : 'current'
                                        }
                                    ]);
                                }
                                const aggregate = await client.query(`SELECT EXISTS (
									   SELECT 1 FROM stripe_invoice_delinquency
									   WHERE organization_id = $1 AND failed
									 ) AS delinquent`, [organizationId]);
                                const delinquent = aggregate.rows[0].delinquent;
                                const stateChanged = Boolean(prior.delinquent_at) !== delinquent;
                                if (stateChanged) {
                                    await client.query(`UPDATE billing_accounts
										 SET delinquent_at = CASE WHEN $3 THEN to_timestamp($4) ELSE NULL END,
										     updated_at = now()
										 WHERE organization_id = $1 AND stripe_customer_id = $2`, [organizationId, customer, delinquent, event.created]);
                                    await client.query(`INSERT INTO audit_events
								 (event_key, organization_id, actor_type, actor_id, action, outcome,
								  resource_type, resource_id, request_id, metadata)
								 VALUES ($1, $2::uuid, 'system', 'stripe',
								         'billing.delinquency_changed', 'succeeded',
								         'billing_account', $2::uuid::text, $3, $4)`, [
                                        `stripe:${event.id}:delinquency`,
                                        organizationId,
                                        context.requestId ?? null,
                                        {
                                            stripe_event_id: event.id,
                                            event_type: event.type,
                                            event_created: event.created,
                                            stripe_invoice_id: invoiceId,
                                            prior_state: prior.delinquent_at ? 'delinquent' : 'current',
                                            state: delinquent ? 'delinquent' : 'current'
                                        }
                                    ]);
                                }
                            }
                        }
                    }
                }
            }
            await client.query('UPDATE stripe_events SET processed_at = now() WHERE id = $1', [event.id]);
            return true;
        });
    }
}
//# sourceMappingURL=stripe.js.map