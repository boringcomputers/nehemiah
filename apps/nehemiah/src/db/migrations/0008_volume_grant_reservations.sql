ALTER TABLE organizations
  ADD COLUMN max_storage_mb bigint NOT NULL DEFAULT 102400
    CHECK (max_storage_mb >= 0);

ALTER TABLE volumes
  ADD COLUMN idempotency_key text,
  ADD COLUMN create_request_hash text,
  ADD CONSTRAINT volumes_create_idempotency_pair_check CHECK (
    (idempotency_key IS NULL AND create_request_hash IS NULL)
    OR (
      idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND create_request_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT volumes_id_tenant_unique
    UNIQUE (id, organization_id, project_id);

CREATE UNIQUE INDEX volumes_create_idempotency_unique
  ON volumes (organization_id, project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE volume_write_grant_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  volume_id text NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation_key text,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  observed_size_at_reservation bigint NOT NULL
    CHECK (observed_size_at_reservation >= 0),
  maximum_bytes bigint NOT NULL CHECK (maximum_bytes > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  issued_at timestamptz,
  FOREIGN KEY (volume_id, organization_id, project_id)
    REFERENCES volumes(id, organization_id, project_id) ON DELETE CASCADE,
  CHECK (operation_key IS NULL OR operation_key ~ '^[A-Za-z0-9._:-]{1,160}$'),
  CHECK (issued_at IS NULL OR issued_at >= created_at),
  UNIQUE (volume_id, operation_key, attempt)
);

CREATE INDEX volume_write_grants_active_idx
  ON volume_write_grant_reservations (volume_id, expires_at);

CREATE FUNCTION reject_volume_create_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.object_prefix IS DISTINCT FROM OLD.object_prefix
    OR NEW.size_limit_bytes IS DISTINCT FROM OLD.size_limit_bytes
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.create_request_hash IS DISTINCT FROM OLD.create_request_hash
  THEN
    RAISE EXCEPTION 'volume create identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER volume_create_identity_immutable
  BEFORE UPDATE ON volumes
  FOR EACH ROW EXECUTE FUNCTION reject_volume_create_identity_update();

CREATE FUNCTION reject_volume_write_grant_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.volume_id IS DISTINCT FROM OLD.volume_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.observed_size_at_reservation IS DISTINCT FROM OLD.observed_size_at_reservation
    OR NEW.maximum_bytes IS DISTINCT FROM OLD.maximum_bytes
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'volume write-grant reservation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER volume_write_grant_identity_immutable
  BEFORE UPDATE ON volume_write_grant_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_volume_write_grant_identity_update();
