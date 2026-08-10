-- Clerk remains an authentication provider, while B.C remains authoritative
-- for local user and organization lifecycle state. Provider sync therefore
-- records only bounded identifiers, a one-way payload digest, and the applied
-- result; raw provider payloads and credentials never enter the database.

-- A Clerk subject is the immutable external identity mapped to one existing
-- local user. Sync is deliberately unable to create or remap users.
CREATE FUNCTION reject_clerk_subject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.clerk_user_id IS DISTINCT FROM OLD.clerk_user_id THEN
    RAISE EXCEPTION 'Clerk subject mappings are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_clerk_subject_immutable
BEFORE UPDATE OF clerk_user_id ON users
FOR EACH ROW EXECUTE FUNCTION reject_clerk_subject_mutation();

CREATE TABLE identity_provider_sync_receipts (
  provider text NOT NULL CHECK (provider = 'clerk'),
  event_id text NOT NULL CHECK (
    octet_length(event_id) BETWEEN 1 AND 128
    AND event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  stream_sha256 text NOT NULL CHECK (stream_sha256 ~ '^[0-9a-f]{64}$'),
  source_version bigint NOT NULL CHECK (source_version BETWEEN 1 AND 9007199254740991),
  event_type text NOT NULL CHECK (event_type IN (
    'user.disabled',
    'user.deleted',
    'membership.upserted',
    'membership.removed'
  )),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  role text CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  result text NOT NULL CHECK (result IN ('applied', 'stale')),
  changed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (provider, event_id),
  UNIQUE (provider, stream_sha256, source_version),
  CHECK (
    (event_type IN ('user.disabled', 'user.deleted')
      AND organization_id IS NULL AND role IS NULL)
    OR
    (event_type = 'membership.upserted'
      AND organization_id IS NOT NULL AND role IS NOT NULL)
    OR
    (event_type = 'membership.removed'
      AND organization_id IS NOT NULL AND role IS NULL)
  )
);

CREATE INDEX identity_provider_sync_receipts_stream_order_idx
  ON identity_provider_sync_receipts (provider, stream_sha256, source_version DESC);

CREATE TRIGGER identity_provider_sync_receipts_append_only
BEFORE UPDATE OR DELETE ON identity_provider_sync_receipts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

COMMENT ON TABLE identity_provider_sync_receipts IS
  'Append-only bounded Clerk sync receipts; payload_sha256 is canonical evidence, never raw provider payload.';
