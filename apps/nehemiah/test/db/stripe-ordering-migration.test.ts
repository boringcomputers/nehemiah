import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/db/client.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

describe('Stripe source-order migration', () => {
	it('persists deterministic per-invoice order and fail-closed legacy evidence', async () => {
		const migration = await readFile(
			new URL('../../src/db/migrations/0021_stripe_event_ordering.sql', import.meta.url),
			'utf8'
		);

		expect(migration).toContain('stripe_created_at timestamptz');
		expect(migration).toContain('CREATE TABLE stripe_invoice_delinquency');
		expect(migration).toContain('PRIMARY KEY (organization_id, stripe_invoice_id)');
		expect(migration).toContain('PARTITION BY organization_id, stripe_invoice_id');
		expect(migration).toContain('legacy-unresolved-');
		expect(migration).toContain('paid=0, payment_failed=1');
	});
});

databaseDescribe('legacy Stripe delinquency repair', () => {
	it('keeps an unresolved sentinel even when one failed invoice was recoverable', async () => {
		const database = new Database(databaseUrl!);
		const organizationId = randomUUID();
		const migration = await readFile(
			new URL('../../src/db/migrations/0024_stripe_legacy_delinquency_guard.sql', import.meta.url),
			'utf8'
		);
		try {
			await database.query(
				`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Legacy Stripe repair')`,
				[organizationId, `stripe-legacy-${organizationId.slice(0, 8)}`]
			);
			await database.query(
				`INSERT INTO billing_accounts (organization_id, stripe_customer_id, delinquent_at)
				 VALUES ($1, $2, now() - interval '1 hour')`,
				[organizationId, `cus_legacy_${organizationId.replaceAll('-', '')}`]
			);
			await database.query(
				`INSERT INTO stripe_invoice_delinquency
				 (organization_id, stripe_invoice_id, failed, stripe_event_created_at,
				  stripe_event_rank, stripe_event_id)
				 VALUES ($1, 'in_recoverable_a', true, now() - interval '1 hour', 1, 'evt_a')`,
				[organizationId]
			);
			await database.query(migration);
			const state = await database.query<{ stripe_invoice_id: string; failed: boolean }>(
				`SELECT stripe_invoice_id, failed FROM stripe_invoice_delinquency
				 WHERE organization_id = $1 ORDER BY stripe_invoice_id`,
				[organizationId]
			);
			expect(state.rows).toEqual([
				{ stripe_invoice_id: 'in_recoverable_a', failed: true },
				{ stripe_invoice_id: `legacy-unresolved-${organizationId}`, failed: true }
			]);
		} finally {
			await database.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
			await database.close();
		}
	});
});
