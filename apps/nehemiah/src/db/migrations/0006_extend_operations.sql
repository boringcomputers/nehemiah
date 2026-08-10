CREATE TABLE machine_extend_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  machine_id text NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  target_expires_at timestamptz NOT NULL,
  result_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id),
  FOREIGN KEY (machine_id, organization_id)
    REFERENCES machines(id, organization_id),
  UNIQUE (organization_id, machine_id, idempotency_key),
  CHECK (
    (result_expires_at IS NULL AND completed_at IS NULL)
    OR (
      result_expires_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND result_expires_at >= target_expires_at
    )
  )
);

CREATE INDEX machine_extend_operations_pending_idx
  ON machine_extend_operations (created_at)
  WHERE completed_at IS NULL;

CREATE FUNCTION reject_machine_extend_operation_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.target_expires_at IS DISTINCT FROM OLD.target_expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'machine extend operation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machine_extend_operation_identity_immutable
  BEFORE UPDATE ON machine_extend_operations
  FOR EACH ROW EXECUTE FUNCTION reject_machine_extend_operation_identity_update();
