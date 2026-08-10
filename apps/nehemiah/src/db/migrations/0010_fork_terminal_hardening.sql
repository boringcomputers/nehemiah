ALTER TABLE machine_fork_operations
  ADD COLUMN audit_operation_id uuid,
  ADD COLUMN cleanup_requested_at timestamptz,
  ADD COLUMN cleanup_failure_status integer,
  ADD COLUMN cleanup_failure_code text,
  ADD COLUMN cleanup_failure_message text,
  ADD COLUMN cleanup_claim_token uuid,
  ADD COLUMN cleanup_claimed_until timestamptz;

-- Existing pre-beta rows did not retain the request audit identity. Give them a
-- durable identity so all new code can use one non-null contract; new operations
-- store the actual requested-event operation id at allocation time.
UPDATE machine_fork_operations
SET audit_operation_id = gen_random_uuid()
WHERE audit_operation_id IS NULL;

ALTER TABLE machine_fork_operations
  ALTER COLUMN audit_operation_id SET NOT NULL,
  ADD CONSTRAINT machine_fork_operations_audit_identity_unique
    UNIQUE (audit_operation_id),
  ADD CONSTRAINT machine_fork_cleanup_decision_check CHECK (
    (
      cleanup_requested_at IS NULL
      AND cleanup_failure_status IS NULL
      AND cleanup_failure_code IS NULL
      AND cleanup_failure_message IS NULL
    )
    OR (
      cleanup_requested_at IS NOT NULL
      AND cleanup_failure_status BETWEEN 400 AND 599
      AND cleanup_failure_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
      AND length(cleanup_failure_message) BETWEEN 1 AND 512
    )
  ),
  ADD CONSTRAINT machine_fork_cleanup_claim_check CHECK (
    (
      cleanup_claim_token IS NULL
      AND cleanup_claimed_until IS NULL
    )
    OR (
      cleanup_requested_at IS NOT NULL
      AND cleanup_claim_token IS NOT NULL
      AND cleanup_claimed_until IS NOT NULL
      AND cleanup_claimed_until > cleanup_requested_at
    )
  );

CREATE INDEX machine_fork_cleanup_ready_idx
  ON machine_fork_operations (cleanup_claimed_until, cleanup_requested_at)
  WHERE state = 'pending' AND cleanup_requested_at IS NOT NULL;

CREATE FUNCTION reject_machine_fork_audit_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.audit_operation_id IS DISTINCT FROM OLD.audit_operation_id THEN
    RAISE EXCEPTION 'machine fork audit identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machine_fork_audit_identity_immutable
  BEFORE UPDATE ON machine_fork_operations
  FOR EACH ROW EXECUTE FUNCTION reject_machine_fork_audit_identity_update();
