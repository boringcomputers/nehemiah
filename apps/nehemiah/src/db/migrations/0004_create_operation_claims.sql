ALTER TABLE machines
  ADD COLUMN create_claim_token uuid,
  ADD COLUMN create_claimed_until timestamptz,
  ADD COLUMN create_failure_status integer,
  ADD COLUMN create_failure_code text,
  ADD COLUMN create_failure_message text;

ALTER TABLE machines
  ADD CONSTRAINT machines_create_claim_complete_check CHECK (
    (create_claim_token IS NULL AND create_claimed_until IS NULL)
    OR (create_claim_token IS NOT NULL AND create_claimed_until IS NOT NULL)
  ),
  ADD CONSTRAINT machines_create_failure_complete_check CHECK (
    (create_failure_status IS NULL
      AND create_failure_code IS NULL
      AND create_failure_message IS NULL)
    OR (
      create_failure_status BETWEEN 400 AND 599
      AND create_failure_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
      AND length(create_failure_message) BETWEEN 1 AND 512
    )
  );

CREATE INDEX machines_create_claim_expiry_idx
  ON machines (create_claimed_until, created_at)
  WHERE state = 'requested' AND create_failure_status IS NULL;
