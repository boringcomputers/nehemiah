-- Projects are permanent tenant authority records in the private beta. Bound
-- their retained cardinality so a tenant cannot grow every project-scoped
-- table and every unpaginated project selector without limit.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM projects
     GROUP BY organization_id
    HAVING count(*) > 64
  ) THEN
    RAISE EXCEPTION 'existing organization project state exceeds the private-beta hard bound';
  END IF;
END;
$$;

ALTER TABLE organizations
  ADD COLUMN max_projects integer NOT NULL DEFAULT 16,
  ADD CONSTRAINT organizations_max_projects_private_beta_bound
    CHECK (max_projects BETWEEN 0 AND 64);

-- Preserve every existing project while keeping the conservative default for
-- ordinary tenants. The preflight above proves this update cannot exceed 64.
UPDATE organizations organization
   SET max_projects = GREATEST(
     16,
     (
       SELECT count(*)::integer
         FROM projects project
        WHERE project.organization_id = organization.id
     )
   );

CREATE FUNCTION enforce_project_allocation_bound()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  organization_max_projects integer;
  retained_projects integer;
BEGIN
  -- This organization row is the cross-replica serialization point for every
  -- writer, including older application processes and direct SQL tooling.
  SELECT organization.max_projects
    INTO organization_max_projects
    FROM public.organizations organization
   WHERE organization.id = NEW.organization_id
   FOR UPDATE;

  -- Let the existing foreign key report an unknown organization.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
    INTO retained_projects
    FROM (
      SELECT 1
        FROM public.projects project
       WHERE project.organization_id = NEW.organization_id
       LIMIT organization_max_projects + 1
    ) bounded_projects;

  IF retained_projects >= organization_max_projects THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization retained project quota exceeded',
      CONSTRAINT = 'projects_organization_retained_quota';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_allocation_bound_insert
BEFORE INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION enforce_project_allocation_bound();

CREATE TRIGGER projects_allocation_bound_move
BEFORE UPDATE OF organization_id ON projects
FOR EACH ROW
WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
EXECUTE FUNCTION enforce_project_allocation_bound();

CREATE FUNCTION enforce_organization_project_limit_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  retained_projects integer;
BEGIN
  IF NEW.max_projects >= OLD.max_projects THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
    INTO retained_projects
    FROM (
      SELECT 1
        FROM public.projects project
       WHERE project.organization_id = NEW.id
       LIMIT 65
    ) bounded_projects;

  IF retained_projects > NEW.max_projects THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'organization project limit is below its retained project count',
      CONSTRAINT = 'organizations_max_projects_below_retained';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_project_limit_update
BEFORE UPDATE OF max_projects ON organizations
FOR EACH ROW EXECUTE FUNCTION enforce_organization_project_limit_update();

COMMENT ON COLUMN organizations.max_projects IS
  'Maximum retained projects for this organization; private-beta hard maximum 64.';
