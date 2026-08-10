ALTER TABLE stripe_events
  ADD COLUMN stripe_created_at timestamptz;

-- Stripe invoice events describe one invoice, not the customer's aggregate
-- balance. Keep independently ordered state for every invoice and derive the
-- account delinquency bit from the complete unresolved set.
CREATE TABLE stripe_invoice_delinquency (
  organization_id uuid NOT NULL REFERENCES billing_accounts(organization_id) ON DELETE CASCADE,
  stripe_invoice_id text NOT NULL
    CHECK (length(stripe_invoice_id) BETWEEN 1 AND 255),
  failed boolean NOT NULL,
  stripe_event_created_at timestamptz NOT NULL,
  stripe_event_rank smallint NOT NULL CHECK (stripe_event_rank IN (0, 1)),
  stripe_event_id text NOT NULL CHECK (length(stripe_event_id) BETWEEN 1 AND 255),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, stripe_invoice_id)
);
CREATE INDEX stripe_invoice_delinquency_open_idx
  ON stripe_invoice_delinquency (organization_id)
  WHERE failed;

-- Recover per-invoice state from legacy payloads when they contain the normal
-- Stripe id/customer/created fields. A same-second failure dominates paid.
WITH candidates AS (
  SELECT account.organization_id,
         event.payload->'data'->'object'->>'id' AS stripe_invoice_id,
         event.event_type,
         event.payload->>'created' AS created_text,
         event.id
  FROM stripe_events event
  JOIN billing_accounts account
    ON account.stripe_customer_id = event.payload->'data'->'object'->>'customer'
  WHERE event.event_type IN ('invoice.paid', 'invoice.payment_failed')
    AND event.payload->'data'->'object'->>'id' IS NOT NULL
    AND length(event.payload->'data'->'object'->>'id') BETWEEN 1 AND 255
), validated AS (
  SELECT *,
         CASE WHEN created_text ~ '^[0-9]{1,10}$' THEN created_text::bigint END AS created_epoch
  FROM candidates
), ordered AS (
  SELECT organization_id,
         stripe_invoice_id,
         event_type = 'invoice.payment_failed' AS failed,
         created_epoch,
         CASE WHEN event_type = 'invoice.payment_failed' THEN 1 ELSE 0 END AS event_rank,
         id,
         row_number() OVER (
           PARTITION BY organization_id, stripe_invoice_id
           ORDER BY created_epoch DESC,
                    CASE WHEN event_type = 'invoice.payment_failed' THEN 1 ELSE 0 END DESC,
                    id DESC
         ) AS ordering
  FROM validated
  WHERE created_epoch BETWEEN 0 AND 4102444800
)
INSERT INTO stripe_invoice_delinquency
 (organization_id, stripe_invoice_id, failed, stripe_event_created_at,
  stripe_event_rank, stripe_event_id)
SELECT organization_id, stripe_invoice_id, failed, to_timestamp(created_epoch), event_rank, id
FROM ordered
WHERE ordering = 1;

-- A pre-migration delinquent account without recoverable open invoice evidence
-- stays fail-closed. This sentinel is intentionally operator-resolved rather
-- than guessed away by an unrelated future invoice.paid event.
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
  AND NOT EXISTS (
    SELECT 1 FROM stripe_invoice_delinquency invoice
    WHERE invoice.organization_id = account.organization_id AND invoice.failed
  );

COMMENT ON TABLE stripe_invoice_delinquency IS
  'Per-invoice Stripe source order; account delinquency is true while any row is failed.';
COMMENT ON COLUMN stripe_invoice_delinquency.stripe_event_rank IS
  'Deterministic same-second ordering: paid=0, payment_failed=1 (fail closed).';
