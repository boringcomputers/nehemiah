-- Device login records contain credential hashes and are not the immutable
-- audit ledger. Keep their retained cardinality bounded across every control-
-- plane replica, then let the runtime reaper remove only terminal records after
-- the explicit evidence window. audit_events remains append-only.

CREATE TABLE device_retention_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  authorization_rows bigint NOT NULL
    CONSTRAINT device_retention_authorization_rows_check
    CHECK (authorization_rows BETWEEN 0 AND 50000),
  family_rows bigint NOT NULL
    CONSTRAINT device_retention_family_rows_check
    CHECK (family_rows BETWEEN 0 AND 4096),
  refresh_token_rows bigint NOT NULL
    CONSTRAINT device_retention_refresh_rows_check
    CHECK (refresh_token_rows BETWEEN 0 AND 1048576),
  access_token_rows bigint NOT NULL
    CONSTRAINT device_retention_access_rows_check
    CHECK (access_token_rows BETWEEN 0 AND 1048576),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

INSERT INTO device_retention_capacity
  (singleton, authorization_rows, family_rows, refresh_token_rows, access_token_rows)
SELECT true,
       (SELECT count(*) FROM device_authorizations),
       (SELECT count(*) FROM device_refresh_families),
       (SELECT count(*) FROM device_refresh_tokens),
       (SELECT count(*) FROM device_access_tokens);

CREATE FUNCTION account_device_retained_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated boolean;
  capacity_constraint text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    CASE TG_TABLE_NAME
      WHEN 'device_authorizations' THEN
        UPDATE public.device_retention_capacity
           SET authorization_rows = authorization_rows + 1,
               updated_at = statement_timestamp()
         WHERE singleton AND authorization_rows < 50000
         RETURNING true INTO updated;
        capacity_constraint := 'device_retention_authorization_capacity';
      WHEN 'device_refresh_families' THEN
        UPDATE public.device_retention_capacity
           SET family_rows = family_rows + 1,
               updated_at = statement_timestamp()
         WHERE singleton AND family_rows < 4096
         RETURNING true INTO updated;
        capacity_constraint := 'device_retention_family_capacity';
      WHEN 'device_refresh_tokens' THEN
        UPDATE public.device_retention_capacity
           SET refresh_token_rows = refresh_token_rows + 1,
               updated_at = statement_timestamp()
         WHERE singleton AND refresh_token_rows < 1048576
         RETURNING true INTO updated;
        capacity_constraint := 'device_retention_refresh_capacity';
      WHEN 'device_access_tokens' THEN
        UPDATE public.device_retention_capacity
           SET access_token_rows = access_token_rows + 1,
               updated_at = statement_timestamp()
         WHERE singleton AND access_token_rows < 1048576
         RETURNING true INTO updated;
        capacity_constraint := 'device_retention_access_capacity';
      ELSE
        RAISE EXCEPTION 'unsupported device retention table' USING ERRCODE = '55000';
    END CASE;
    IF NOT COALESCE(updated, false) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'device authorization retained-row capacity reached',
        CONSTRAINT = capacity_constraint;
    END IF;
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'device_authorizations' THEN
      UPDATE public.device_retention_capacity
         SET authorization_rows = authorization_rows - 1,
             updated_at = statement_timestamp()
       WHERE singleton AND authorization_rows > 0
       RETURNING true INTO updated;
    WHEN 'device_refresh_families' THEN
      UPDATE public.device_retention_capacity
         SET family_rows = family_rows - 1,
             updated_at = statement_timestamp()
       WHERE singleton AND family_rows > 0
       RETURNING true INTO updated;
    WHEN 'device_refresh_tokens' THEN
      UPDATE public.device_retention_capacity
         SET refresh_token_rows = refresh_token_rows - 1,
             updated_at = statement_timestamp()
       WHERE singleton AND refresh_token_rows > 0
       RETURNING true INTO updated;
    WHEN 'device_access_tokens' THEN
      UPDATE public.device_retention_capacity
         SET access_token_rows = access_token_rows - 1,
             updated_at = statement_timestamp()
       WHERE singleton AND access_token_rows > 0
       RETURNING true INTO updated;
    ELSE
      RAISE EXCEPTION 'unsupported device retention table' USING ERRCODE = '55000';
  END CASE;
  IF NOT COALESCE(updated, false) THEN
    RAISE EXCEPTION 'device retention counter underflow' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION account_device_retained_row() FROM PUBLIC;

CREATE TRIGGER device_authorizations_retention_insert
BEFORE INSERT ON device_authorizations
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();
CREATE TRIGGER device_authorizations_retention_delete
AFTER DELETE ON device_authorizations
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();

CREATE TRIGGER device_refresh_families_retention_insert
BEFORE INSERT ON device_refresh_families
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();
CREATE TRIGGER device_refresh_families_retention_delete
AFTER DELETE ON device_refresh_families
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();

CREATE TRIGGER device_refresh_tokens_retention_insert
BEFORE INSERT ON device_refresh_tokens
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();
CREATE TRIGGER device_refresh_tokens_retention_delete
AFTER DELETE ON device_refresh_tokens
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();

CREATE TRIGGER device_access_tokens_retention_insert
BEFORE INSERT ON device_access_tokens
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();
CREATE TRIGGER device_access_tokens_retention_delete
AFTER DELETE ON device_access_tokens
FOR EACH ROW EXECUTE FUNCTION account_device_retained_row();

CREATE INDEX device_authorizations_retention_idx
  ON device_authorizations (expires_at, id);
CREATE INDEX device_refresh_families_retention_idx
  ON device_refresh_families ((COALESCE(revoked_at, expires_at)), id);
CREATE INDEX device_access_tokens_terminal_retention_idx
  ON device_access_tokens ((COALESCE(revoked_at, expires_at)), id);

COMMENT ON TABLE device_retention_capacity IS
  'Fixed singleton counters serialized by security-definer row triggers; direct runtime mutation is forbidden.';
COMMENT ON COLUMN device_retention_capacity.authorization_rows IS
  'Hard global ceiling includes active and retained device authorization records.';
