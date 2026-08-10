CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY,
  device_token_hash bytea NOT NULL CHECK (octet_length(device_token_hash) = 32),
  user_code_hash bytea NOT NULL UNIQUE CHECK (octet_length(user_code_hash) = 32),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  requested_scopes text[] NOT NULL CHECK (
    cardinality(requested_scopes) BETWEEN 1 AND 7
    AND requested_scopes <@ ARRAY[
      'machines:read', 'machines:write', 'templates:read', 'templates:write',
      'volumes:read', 'volumes:write', 'billing:read'
    ]::text[]
  ),
  approved_scopes text[],
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id uuid,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  poll_interval_seconds integer NOT NULL DEFAULT 5
    CHECK (poll_interval_seconds BETWEEN 5 AND 60),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  poll_violations integer NOT NULL DEFAULT 0 CHECK (poll_violations >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  authorized_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (approved_scopes IS NULL OR (
    cardinality(approved_scopes) BETWEEN 1 AND 7
    AND approved_scopes <@ requested_scopes
  )),
  CHECK (
    (status = 'pending' AND organization_id IS NULL AND project_id IS NULL
      AND approved_by IS NULL AND approved_scopes IS NULL
      AND authorized_at IS NULL AND denied_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'denied' AND organization_id IS NOT NULL AND project_id IS NULL
      AND approved_by IS NOT NULL AND approved_scopes IS NULL
      AND authorized_at IS NULL AND denied_at IS NOT NULL AND consumed_at IS NULL)
    OR
    (status = 'approved' AND organization_id IS NOT NULL AND project_id IS NOT NULL
      AND approved_by IS NOT NULL AND approved_scopes IS NOT NULL
      AND authorized_at IS NOT NULL AND denied_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'consumed' AND organization_id IS NOT NULL AND project_id IS NOT NULL
      AND approved_by IS NOT NULL AND approved_scopes IS NOT NULL
      AND authorized_at IS NOT NULL AND denied_at IS NULL AND consumed_at IS NOT NULL)
  )
);
CREATE INDEX device_authorizations_expiry_idx
  ON device_authorizations (expires_at) WHERE status IN ('pending', 'approved');

CREATE TABLE device_authorization_rate_limits (
  kind text NOT NULL CHECK (kind IN ('issue_source', 'issue_global', 'approve_actor')),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (kind, key_hash, window_started_at)
);
CREATE INDEX device_authorization_rate_limits_expiry_idx
  ON device_authorization_rate_limits (window_started_at);

CREATE TABLE device_refresh_families (
  id uuid PRIMARY KEY,
  device_authorization_id uuid NOT NULL UNIQUE
    REFERENCES device_authorizations(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 7
    AND scopes <@ ARRAY[
      'machines:read', 'machines:write', 'templates:read', 'templates:write',
      'volumes:read', 'volumes:write', 'billing:read'
    ]::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reuse_detected_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (reuse_detected_at IS NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX device_refresh_families_tenant_idx
  ON device_refresh_families (organization_id, project_id)
  WHERE revoked_at IS NULL;

CREATE TABLE device_refresh_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES device_refresh_families(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation >= 0),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replaced_by uuid REFERENCES device_refresh_tokens(id) ON DELETE RESTRICT,
  UNIQUE (family_id, generation),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL AND replaced_by IS NULL) OR used_at IS NOT NULL)
);

CREATE TABLE device_access_tokens (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES device_refresh_families(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 7
    AND scopes <@ ARRAY[
      'machines:read', 'machines:write', 'templates:read', 'templates:write',
      'volumes:read', 'volumes:write', 'billing:read'
    ]::text[]
  ),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);
CREATE INDEX device_access_tokens_family_active_idx
  ON device_access_tokens (family_id, expires_at) WHERE revoked_at IS NULL;
