-- One-use, identity-bound host enrollment grants replace the reusable fleet
-- bootstrap bearer. Only the SHA-256 token digest is retained.

CREATE TABLE host_enrollment_grants (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  host_id uuid NOT NULL,
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  region_id text NOT NULL CHECK (region_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  address inet NOT NULL,
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'aarch64')),
  total_vcpus integer NOT NULL CHECK (total_vcpus BETWEEN 1 AND 4096),
  total_memory_mb integer NOT NULL CHECK (total_memory_mb BETWEEN 1 AND 16777216),
  total_disk_mb bigint NOT NULL CHECK (total_disk_mb BETWEEN 1 AND 9007199254740991),
  issued_by_organization_id uuid NOT NULL,
  issued_by_user_id text NOT NULL CHECK (
    length(issued_by_user_id) BETWEEN 1 AND 256 AND
    issued_by_user_id !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at >= created_at + interval '1 minute'),
  CHECK (expires_at <= created_at + interval '30 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX host_enrollment_grants_active_provider_idx
  ON host_enrollment_grants (provider_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX host_enrollment_grants_active_host_idx
  ON host_enrollment_grants (host_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX host_enrollment_grants_active_address_idx
  ON host_enrollment_grants (address)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX host_enrollment_grants_expiry_idx
  ON host_enrollment_grants (expires_at, id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION enforce_host_enrollment_grant_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'host enrollment grants cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.host_id IS DISTINCT FROM OLD.host_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.region_id IS DISTINCT FROM OLD.region_id
     OR NEW.address IS DISTINCT FROM OLD.address
     OR NEW.architecture IS DISTINCT FROM OLD.architecture
     OR NEW.total_vcpus IS DISTINCT FROM OLD.total_vcpus
     OR NEW.total_memory_mb IS DISTINCT FROM OLD.total_memory_mb
     OR NEW.total_disk_mb IS DISTINCT FROM OLD.total_disk_mb
     OR NEW.issued_by_organization_id IS DISTINCT FROM OLD.issued_by_organization_id
     OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'host enrollment grant identity is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'host enrollment consumption is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'host enrollment revocation is immutable';
  END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked host enrollment grant cannot be consumed';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed host enrollment grant cannot be revoked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER host_enrollment_grants_lifecycle
BEFORE UPDATE OR DELETE ON host_enrollment_grants
FOR EACH ROW EXECUTE FUNCTION enforce_host_enrollment_grant_lifecycle();
