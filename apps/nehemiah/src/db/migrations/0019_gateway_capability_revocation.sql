-- Every gateway JWT is backed by one durable, exactly scoped grant. Existing
-- preview-only grants cannot be issuer-bound retroactively, so revoke them at
-- migration time instead of silently treating them as authoritative.
ALTER TABLE machine_gateway_grants
  ADD COLUMN capabilities text[],
  ADD COLUMN issuer_type text,
  ADD COLUMN issuer_id text,
  ADD COLUMN revoked_at timestamptz;

UPDATE machine_gateway_grants
SET capabilities = ARRAY[capability],
    issuer_type = 'legacy',
    issuer_id = 'migration:0019',
    revoked_at = COALESCE(revoked_at, statement_timestamp());

DROP INDEX machine_gateway_grants_resolution_idx;
ALTER TABLE machine_gateway_grants
  DROP CONSTRAINT machine_gateway_grants_capability_check,
  DROP CONSTRAINT machine_gateway_grants_port_check,
  DROP COLUMN capability,
  ALTER COLUMN capabilities SET NOT NULL,
  ALTER COLUMN issuer_type SET NOT NULL,
  ALTER COLUMN issuer_id SET NOT NULL,
  ALTER COLUMN port DROP NOT NULL;

CREATE FUNCTION gateway_capabilities_are_canonical(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT value = ARRAY(
    SELECT capability
    FROM unnest(ARRAY['tty', 'vnc', 'agent', 'files', 'preview']::text[])
      WITH ORDINALITY AS allowed(capability, ordinal)
    WHERE capability = ANY(value)
    ORDER BY ordinal
  );
$$;

ALTER TABLE machine_gateway_grants
  ADD CONSTRAINT machine_gateway_grants_capabilities_check CHECK (
    cardinality(capabilities) BETWEEN 1 AND 5
    AND gateway_capabilities_are_canonical(capabilities)
  ),
  ADD CONSTRAINT machine_gateway_grants_port_check CHECK (
    (port IS NOT NULL) = ('preview' = ANY(capabilities))
    AND (port IS NULL OR port BETWEEN 1 AND 65535)
  ),
  ADD CONSTRAINT machine_gateway_grants_issuer_check CHECK (
    issuer_type IN ('api_key', 'clerk_user', 'device_family', 'legacy')
    AND char_length(issuer_id) BETWEEN 1 AND 256
    AND issuer_id = btrim(issuer_id)
    AND (issuer_type <> 'legacy' OR revoked_at IS NOT NULL)
  ),
  ADD CONSTRAINT machine_gateway_grants_revocation_check CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  );

CREATE OR REPLACE FUNCTION machine_gateway_grant_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.machine_id, NEW.organization_id, NEW.project_id,
         NEW.lease_id, NEW.capabilities, NEW.port, NEW.expires_at,
         NEW.created_at, NEW.issuer_type, NEW.issuer_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.machine_id, OLD.organization_id, OLD.project_id,
         OLD.lease_id, OLD.capabilities, OLD.port, OLD.expires_at,
         OLD.created_at, OLD.issuer_type, OLD.issuer_id) THEN
    RAISE EXCEPTION 'machine gateway grant identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'machine gateway grant revocation is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER machine_gateway_grant_identity_immutable
BEFORE UPDATE ON machine_gateway_grants
FOR EACH ROW EXECUTE FUNCTION machine_gateway_grant_identity_immutable();

CREATE INDEX machine_gateway_grants_resolution_idx
  ON machine_gateway_grants
    (id, machine_id, organization_id, project_id, lease_id,
     capabilities, port, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX machine_gateway_grants_active_issuer_idx
  ON machine_gateway_grants (issuer_type, issuer_id, organization_id, expires_at, id)
  WHERE revoked_at IS NULL;
