-- Pre-0021 billing_accounts kept only an aggregate delinquent bit. Even when
-- one legacy failed invoice can be recovered, that evidence cannot prove there
-- was no second malformed/unrecoverable failed invoice. Preserve one explicit
-- operator-resolved sentinel for every account that was delinquent at upgrade;
-- later invoice.paid events must never guess this historical debt away.
INSERT INTO stripe_invoice_delinquency
 (organization_id, stripe_invoice_id, failed, stripe_event_created_at,
  stripe_event_rank, stripe_event_id)
SELECT account.organization_id,
       'legacy-unresolved-' || account.organization_id::text,
       true,
       account.delinquent_at,
       1,
       'legacy-unresolved'
FROM billing_accounts account
WHERE account.delinquent_at IS NOT NULL
ON CONFLICT (organization_id, stripe_invoice_id) DO NOTHING;

COMMENT ON COLUMN stripe_invoice_delinquency.stripe_invoice_id IS
  'Stripe invoice id, or a legacy-unresolved-<organization UUID> sentinel requiring operator resolution after aggregate-only upgrades.';
