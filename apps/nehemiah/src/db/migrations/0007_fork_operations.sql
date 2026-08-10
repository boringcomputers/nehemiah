CREATE TYPE fork_operation_state AS ENUM ('pending', 'succeeded', 'failed');

ALTER TABLE machines
  ADD CONSTRAINT machines_host_lease_identity_unique
    UNIQUE (id, host_id, host_machine_id, lease_id);

CREATE TABLE machine_fork_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  source_machine_id text NOT NULL,
  source_host_id uuid NOT NULL REFERENCES hosts(id),
  source_host_machine_id text NOT NULL,
  source_lease_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  child_count smallint NOT NULL CHECK (child_count BETWEEN 1 AND 8),
  state fork_operation_state NOT NULL DEFAULT 'pending',
  failure_status integer,
  failure_code text,
  failure_message text,
  reconcile_after timestamptz NOT NULL DEFAULT now(),
  reconcile_claim_token uuid,
  reconcile_claimed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id),
  FOREIGN KEY (source_machine_id, organization_id)
    REFERENCES machines(id, organization_id),
  FOREIGN KEY (source_machine_id, source_host_id, source_host_machine_id, source_lease_id)
    REFERENCES machines(id, host_id, host_machine_id, lease_id),
  UNIQUE (id, organization_id, project_id),
  UNIQUE (organization_id, project_id, source_machine_id, idempotency_key),
  CHECK (
    (reconcile_claim_token IS NULL AND reconcile_claimed_until IS NULL)
    OR (reconcile_claim_token IS NOT NULL AND reconcile_claimed_until IS NOT NULL)
  ),
  CHECK (
    (state = 'pending'
      AND completed_at IS NULL
      AND failure_status IS NULL
      AND failure_code IS NULL
      AND failure_message IS NULL)
    OR (state = 'succeeded'
      AND completed_at IS NOT NULL
      AND failure_status IS NULL
      AND failure_code IS NULL
      AND failure_message IS NULL)
    OR (state = 'failed'
      AND completed_at IS NOT NULL
      AND failure_status BETWEEN 400 AND 599
      AND failure_code ~ '^[a-z][a-z0-9._:-]{0,127}$'
      AND length(failure_message) BETWEEN 1 AND 512)
  )
);

ALTER TABLE machines
  ADD COLUMN parent_machine_id text,
  ADD COLUMN fork_operation_id uuid,
  ADD CONSTRAINT machines_parent_tenant_fk
    FOREIGN KEY (parent_machine_id, organization_id)
    REFERENCES machines(id, organization_id),
  ADD CONSTRAINT machines_fork_operation_fk
    FOREIGN KEY (fork_operation_id, organization_id, project_id)
    REFERENCES machine_fork_operations(id, organization_id, project_id),
  ADD CONSTRAINT machines_fork_child_identity_unique
    UNIQUE (id, fork_operation_id, lease_id);

CREATE INDEX machines_parent_idx
  ON machines (organization_id, project_id, parent_machine_id)
  WHERE parent_machine_id IS NOT NULL;
CREATE INDEX machines_pending_fork_idx
  ON machines (fork_operation_id, state)
  WHERE fork_operation_id IS NOT NULL AND state = 'starting';

CREATE TABLE machine_fork_children (
  operation_id uuid NOT NULL REFERENCES machine_fork_operations(id) ON DELETE CASCADE,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  machine_id text NOT NULL UNIQUE,
  lease_id uuid NOT NULL UNIQUE,
  FOREIGN KEY (machine_id, operation_id, lease_id)
    REFERENCES machines(id, fork_operation_id, lease_id),
  PRIMARY KEY (operation_id, ordinal)
);

CREATE INDEX machine_fork_operations_reconcile_idx
  ON machine_fork_operations (reconcile_after, created_at)
  WHERE state = 'pending';

CREATE FUNCTION reject_machine_fork_operation_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.source_machine_id IS DISTINCT FROM OLD.source_machine_id
    OR NEW.source_host_id IS DISTINCT FROM OLD.source_host_id
    OR NEW.source_host_machine_id IS DISTINCT FROM OLD.source_host_machine_id
    OR NEW.source_lease_id IS DISTINCT FROM OLD.source_lease_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.child_count IS DISTINCT FROM OLD.child_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'machine fork operation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machine_fork_operation_identity_immutable
  BEFORE UPDATE ON machine_fork_operations
  FOR EACH ROW EXECUTE FUNCTION reject_machine_fork_operation_identity_update();

CREATE FUNCTION reject_machine_fork_child_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
    OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
  THEN
    RAISE EXCEPTION 'machine fork child identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machine_fork_child_identity_immutable
  BEFORE UPDATE ON machine_fork_children
  FOR EACH ROW EXECUTE FUNCTION reject_machine_fork_child_identity_update();
