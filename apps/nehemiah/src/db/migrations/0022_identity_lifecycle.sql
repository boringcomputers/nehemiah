-- B.C-owned lifecycle state is authoritative even when the external identity
-- provider continues to authenticate a session. Disabling an identity is
-- reversible, but credentials and capabilities revoked during containment are
-- deliberately not resurrected by a later enable.
ALTER TABLE users
  ADD COLUMN disabled_at timestamptz,
  ADD CONSTRAINT users_disabled_at_check
    CHECK (disabled_at IS NULL OR disabled_at >= created_at);

ALTER TABLE organizations
  ADD COLUMN disabled_at timestamptz,
  ADD CONSTRAINT organizations_disabled_at_check
    CHECK (disabled_at IS NULL OR disabled_at >= created_at);

ALTER TABLE api_keys
  ADD COLUMN disabled_at timestamptz,
  ADD CONSTRAINT api_keys_disabled_at_check
    CHECK (disabled_at IS NULL OR disabled_at >= created_at);

DROP INDEX api_keys_org_idx;
CREATE INDEX api_keys_org_idx ON api_keys (organization_id, created_at DESC)
  WHERE revoked_at IS NULL AND disabled_at IS NULL;

-- A disabled or revoked API key may already have issued short-lived gateway
-- grants. Revoke those in the same statement transaction even when the state
-- transition is performed by an operator tool rather than the application.
CREATE FUNCTION identity_revoke_api_key_dependents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
     OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    UPDATE machine_gateway_grants
       SET revoked_at = COALESCE(revoked_at, statement_timestamp())
     WHERE issuer_type = 'api_key'
       AND issuer_id = NEW.id::text
       AND organization_id = NEW.organization_id
       AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER api_keys_revoke_dependents
AFTER UPDATE OF disabled_at, revoked_at ON api_keys
FOR EACH ROW EXECUTE FUNCTION identity_revoke_api_key_dependents();

-- Device access tokens inherit the approving B.C user and membership through
-- their immutable device authorization. A global user disable permanently
-- revokes every associated refresh family/access token and every outstanding
-- Clerk or device-family gateway grant.
CREATE FUNCTION identity_revoke_user_dependents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    UPDATE device_refresh_families family
       SET revoked_at = COALESCE(family.revoked_at, statement_timestamp())
      FROM device_authorizations device_auth
     WHERE device_auth.id = family.device_authorization_id
       AND device_auth.approved_by = NEW.id
       AND family.revoked_at IS NULL;

    UPDATE device_access_tokens access_token
       SET revoked_at = COALESCE(access_token.revoked_at, statement_timestamp())
      FROM device_refresh_families family,
           device_authorizations device_auth
     WHERE access_token.family_id = family.id
       AND device_auth.id = family.device_authorization_id
       AND device_auth.approved_by = NEW.id
       AND access_token.revoked_at IS NULL;

    UPDATE machine_gateway_grants grant_record
       SET revoked_at = COALESCE(grant_record.revoked_at, statement_timestamp())
     WHERE grant_record.revoked_at IS NULL
       AND (
         (grant_record.issuer_type = 'clerk_user'
          AND grant_record.issuer_id = NEW.clerk_user_id)
         OR
         (grant_record.issuer_type = 'device_family' AND EXISTS (
           SELECT 1
             FROM device_refresh_families family
             JOIN device_authorizations device_auth
               ON device_auth.id = family.device_authorization_id
            WHERE family.id::text = grant_record.issuer_id
              AND device_auth.approved_by = NEW.id
         ))
       );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_dependents
AFTER UPDATE OF disabled_at ON users
FOR EACH ROW EXECUTE FUNCTION identity_revoke_user_dependents();

-- Organization disable is reversible for the organization and its API keys,
-- but all bearer/device sessions issued before containment are terminated.
CREATE FUNCTION identity_revoke_organization_dependents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    UPDATE device_refresh_families
       SET revoked_at = COALESCE(revoked_at, statement_timestamp())
     WHERE organization_id = NEW.id AND revoked_at IS NULL;

    UPDATE device_access_tokens
       SET revoked_at = COALESCE(revoked_at, statement_timestamp())
     WHERE organization_id = NEW.id AND revoked_at IS NULL;

    UPDATE machine_gateway_grants
       SET revoked_at = COALESCE(revoked_at, statement_timestamp())
     WHERE organization_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_revoke_dependents
AFTER UPDATE OF disabled_at ON organizations
FOR EACH ROW EXECUTE FUNCTION identity_revoke_organization_dependents();

-- Removing a membership immediately terminates credentials approved through
-- that membership. Role changes remain live-authorized by the application and
-- gateway resolver; a role downgrade is not silently made reversible after a
-- token refresh has already revoked its family.
CREATE FUNCTION identity_revoke_membership_dependents()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clerk_subject text;
BEGIN
  SELECT clerk_user_id INTO clerk_subject FROM users WHERE id = OLD.user_id;

  UPDATE device_refresh_families family
     SET revoked_at = COALESCE(family.revoked_at, statement_timestamp())
    FROM device_authorizations device_auth
   WHERE device_auth.id = family.device_authorization_id
     AND device_auth.approved_by = OLD.user_id
     AND family.organization_id = OLD.organization_id
     AND family.revoked_at IS NULL;

  UPDATE device_access_tokens access_token
     SET revoked_at = COALESCE(access_token.revoked_at, statement_timestamp())
    FROM device_refresh_families family,
         device_authorizations device_auth
   WHERE access_token.family_id = family.id
     AND device_auth.id = family.device_authorization_id
     AND device_auth.approved_by = OLD.user_id
     AND family.organization_id = OLD.organization_id
     AND access_token.revoked_at IS NULL;

  UPDATE machine_gateway_grants grant_record
     SET revoked_at = COALESCE(grant_record.revoked_at, statement_timestamp())
   WHERE grant_record.organization_id = OLD.organization_id
     AND grant_record.revoked_at IS NULL
     AND (
       (grant_record.issuer_type = 'clerk_user'
        AND grant_record.issuer_id = clerk_subject)
       OR
       (grant_record.issuer_type = 'device_family' AND EXISTS (
         SELECT 1
           FROM device_refresh_families family
           JOIN device_authorizations device_auth
             ON device_auth.id = family.device_authorization_id
          WHERE family.id::text = grant_record.issuer_id
            AND family.organization_id = OLD.organization_id
            AND device_auth.approved_by = OLD.user_id
       ))
     );
  RETURN OLD;
END;
$$;

CREATE TRIGGER organization_members_revoke_dependents
AFTER DELETE ON organization_members
FOR EACH ROW EXECUTE FUNCTION identity_revoke_membership_dependents();
