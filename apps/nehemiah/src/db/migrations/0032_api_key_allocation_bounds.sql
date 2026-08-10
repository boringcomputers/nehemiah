-- API-key material is intentionally expensive to hash. Keep both live bearer
-- cardinality and retained lifecycle history bounded per tenant even when an
-- older writer or an operator tool bypasses the application service.
--
-- The organization row is the serialization point for organization and
-- project limits. This avoids count-then-insert races across control-plane
-- replicas without adding an unbounded counter table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM api_keys
     GROUP BY organization_id
    HAVING count(*) FILTER (WHERE revoked_at IS NULL) > 64
        OR count(*) > 4096
  ) THEN
    RAISE EXCEPTION 'existing organization API-key state exceeds the private-beta bounds';
  END IF;

  IF EXISTS (
    SELECT 1 FROM api_keys
     WHERE project_id IS NOT NULL
     GROUP BY organization_id, project_id
    HAVING count(*) FILTER (WHERE revoked_at IS NULL) > 16
        OR count(*) > 1024
  ) THEN
    RAISE EXCEPTION 'existing project API-key state exceeds the private-beta bounds';
  END IF;
END;
$$;

CREATE FUNCTION enforce_api_key_allocation_bounds()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization_active bigint;
  organization_retained bigint;
  project_active bigint;
  project_retained bigint;
BEGIN
  -- This row lock is taken before counting so concurrent inserts in any
  -- process observe one another. The application takes the same lock before
  -- its administrator locks to keep lock order deterministic.
  PERFORM 1 FROM organizations WHERE id = NEW.organization_id FOR UPDATE;

  SELECT count(*) FILTER (WHERE revoked_at IS NULL), count(*)
    INTO organization_active, organization_retained
    FROM api_keys
   WHERE organization_id = NEW.organization_id;

  IF organization_active >= 64 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization active API-key quota exceeded',
      CONSTRAINT = 'api_keys_organization_active_quota';
  END IF;
  IF organization_retained >= 4096 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization retained API-key quota exceeded',
      CONSTRAINT = 'api_keys_organization_retained_quota';
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE revoked_at IS NULL), count(*)
      INTO project_active, project_retained
      FROM api_keys
     WHERE organization_id = NEW.organization_id
       AND project_id = NEW.project_id;

    IF project_active >= 16 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'project active API-key quota exceeded',
        CONSTRAINT = 'api_keys_project_active_quota';
    END IF;
    IF project_retained >= 1024 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'project retained API-key quota exceeded',
        CONSTRAINT = 'api_keys_project_retained_quota';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER api_keys_allocation_bounds
BEFORE INSERT ON api_keys
FOR EACH ROW EXECUTE FUNCTION enforce_api_key_allocation_bounds();
