-- A pre-beta rollout must not preserve historical caller-controlled headers in
-- the immutable audit ledger. Operators upgrading a populated development DB
-- must explicitly rebuild/scrub it rather than silently mutating audit history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM audit_events
    WHERE user_agent IS NOT NULL
      AND user_agent !~ '^sha256:[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION
      'authentication audit rollout requires every existing user_agent to be null or a sha256 fingerprint';
  END IF;
END
$$;

-- These counters retain no token, prefix, actor, address, or route material.
-- They bound cardinality while preserving the complete attempt count for the
-- current detection window; representative immutable events are emitted once
-- per slot/outcome/window by the application.
CREATE TABLE authentication_attempt_windows (
  credential_kind text NOT NULL CHECK (credential_kind IN (
    'api_key', 'device_access', 'clerk', 'unknown'
  )),
  bucket_slot integer NOT NULL CHECK (bucket_slot >= 0 AND bucket_slot < 65536),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 2000000002),
  succeeded_count integer NOT NULL CHECK (succeeded_count BETWEEN 0 AND 1000000001),
  denied_count integer NOT NULL CHECK (denied_count BETWEEN 0 AND 1000000001),
  last_reason_code text,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (credential_kind, bucket_slot),
  CHECK (succeeded_count + denied_count <= attempt_count)
);

COMMENT ON TABLE authentication_attempt_windows IS
  'Fixed-cardinality authentication anomaly counters; identifiers are collision-conservative keyed slots only.';

CREATE FUNCTION fingerprint_audit_user_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_agent IS NULL OR NEW.user_agent = '' THEN
    NEW.user_agent := NULL;
  ELSIF NEW.user_agent !~ '^sha256:[0-9a-f]{64}$' THEN
    NEW.user_agent := 'sha256:' || encode(digest(convert_to(NEW.user_agent, 'UTF8'), 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_user_agent_fingerprint
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION fingerprint_audit_user_agent();
