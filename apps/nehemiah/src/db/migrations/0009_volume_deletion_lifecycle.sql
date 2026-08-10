-- Legacy volumes predate mandatory expiry and durable create identity. Temporarily
-- remove the identity trigger so those incomplete rows can be repaired once.
DROP TRIGGER volume_create_identity_immutable ON volumes;

UPDATE volumes
SET expires_at = GREATEST(
  -- Legacy NULL meant non-expiring. Preserve at least a full grace window from
  -- this migration instead of immediately expiring old, still-owned data.
  created_at + interval '30 days',
  statement_timestamp() + interval '30 days'
)
WHERE expires_at IS NULL;

-- A half-present identity cannot be replayed safely. Treat it as a legacy,
-- non-idempotent row instead of manufacturing an identity that was never issued.
UPDATE volumes
SET idempotency_key = NULL,
    create_request_hash = NULL
WHERE (idempotency_key IS NULL) <> (create_request_hash IS NULL);

ALTER TABLE volumes
  ALTER COLUMN expires_at SET NOT NULL,
  DROP CONSTRAINT volumes_create_idempotency_pair_check,
  ADD CONSTRAINT volumes_create_idempotency_pair_check CHECK (
    (idempotency_key IS NULL AND create_request_hash IS NULL)
    OR (
      idempotency_key IS NOT NULL
      AND create_request_hash IS NOT NULL
      AND idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND create_request_hash ~ '^[0-9a-f]{64}$'
    )
  );

CREATE TRIGGER volume_create_identity_immutable
  BEFORE UPDATE ON volumes
  FOR EACH ROW EXECUTE FUNCTION reject_volume_create_identity_update();

-- Scheduling object deletion is an external side effect. Keep it in a durable
-- outbox so an API timeout, process crash, or poison object cannot silently lose
-- the retention request or starve unrelated volumes.
CREATE TABLE volume_deletion_jobs (
  volume_id text PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  delete_after timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  scheduled_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (volume_id, organization_id, project_id)
    REFERENCES volumes(id, organization_id, project_id) ON DELETE CASCADE,
  CHECK (delete_after >= requested_at),
  CHECK (
    (claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL)
    OR (
      claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at > claimed_at
    )
  ),
  CHECK (scheduled_at IS NULL OR scheduled_at >= requested_at),
  CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
  )
);

CREATE INDEX volume_deletion_jobs_ready_idx
  ON volume_deletion_jobs (next_attempt_at, requested_at, volume_id)
  WHERE scheduled_at IS NULL;

-- Old explicit deletes were scheduled best-effort. Re-enqueueing them is safe
-- because scheduleDeletion is required to be idempotent.
INSERT INTO volume_deletion_jobs
 (volume_id, organization_id, project_id, delete_after, requested_at,
  next_attempt_at, updated_at)
SELECT id,
       organization_id,
       project_id,
       deleted_at + interval '7 days',
       deleted_at,
       deleted_at,
       deleted_at
FROM volumes
WHERE deleted_at IS NOT NULL
ON CONFLICT (volume_id) DO NOTHING;
