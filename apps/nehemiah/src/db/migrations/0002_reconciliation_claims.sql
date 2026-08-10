ALTER TABLE machines
  ADD COLUMN startup_deadline_at timestamptz,
  ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_claim_token uuid,
  ADD COLUMN reconcile_claimed_until timestamptz,
  ADD COLUMN usage_quarantined_at timestamptz,
  ADD COLUMN usage_quarantine_reason text;

UPDATE machines
SET startup_deadline_at = COALESCE(placed_at, created_at) + interval '2 minutes'
WHERE state = 'starting' AND startup_deadline_at IS NULL;

CREATE INDEX machines_reconcile_ready_idx
  ON machines (reconcile_after, created_at)
  WHERE state IN ('starting', 'stopping', 'running');

ALTER TABLE usage_outbox
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz;

CREATE INDEX usage_outbox_ready_idx
  ON usage_outbox (next_attempt_at, created_at)
  WHERE processed_at IS NULL;
