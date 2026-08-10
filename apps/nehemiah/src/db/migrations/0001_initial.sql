CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE machine_state AS ENUM (
  'requested', 'placing', 'starting', 'running', 'stopping', 'stopped', 'failed', 'lost'
);
CREATE TYPE host_state AS ENUM ('ready', 'draining', 'unhealthy', 'stale');
CREATE TYPE template_replica_state AS ENUM ('requested', 'pulling', 'ready', 'failed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  max_machines integer NOT NULL DEFAULT 10 CHECK (max_machines >= 0),
  max_vcpus integer NOT NULL DEFAULT 20 CHECK (max_vcpus >= 0),
  max_memory_mb integer NOT NULL DEFAULT 20480 CHECK (max_memory_mb >= 0),
  max_storage_mb bigint NOT NULL DEFAULT 102400 CHECK (max_storage_mb >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (id, organization_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL CHECK (key_hash LIKE '$argon2id$%'),
  scopes text[] NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
	CHECK (cardinality(scopes) > 0),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id) WHERE revoked_at IS NULL;

CREATE TABLE regions (
  id text PRIMARY KEY,
  provider text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO regions (id, provider, display_name)
VALUES ('ca-tor-1', 'latitude', 'Toronto, Canada');

CREATE TABLE hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text UNIQUE,
  region_id text NOT NULL REFERENCES regions(id),
  address inet NOT NULL UNIQUE,
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'aarch64')),
  state host_state NOT NULL DEFAULT 'unhealthy',
  credential_hash text NOT NULL,
  control_credential_ciphertext text NOT NULL,
  gateway_credential_ciphertext text NOT NULL,
  daemon_version text NOT NULL DEFAULT 'unknown',
  total_vcpus integer NOT NULL CHECK (total_vcpus > 0),
  total_memory_mb integer NOT NULL CHECK (total_memory_mb > 0),
  total_disk_mb bigint NOT NULL CHECK (total_disk_mb > 0),
  reserved_vcpus integer NOT NULL DEFAULT 0 CHECK (reserved_vcpus >= 0),
  reserved_memory_mb integer NOT NULL DEFAULT 0 CHECK (reserved_memory_mb >= 0),
  reserved_disk_mb bigint NOT NULL DEFAULT 0 CHECK (reserved_disk_mb >= 0),
  reported_available_vcpus integer CHECK (reported_available_vcpus IS NULL OR reported_available_vcpus >= 0),
  reported_available_memory_mb integer CHECK (reported_available_memory_mb IS NULL OR reported_available_memory_mb >= 0),
  reported_available_disk_mb bigint CHECK (reported_available_disk_mb IS NULL OR reported_available_disk_mb >= 0),
  reported_machine_count integer CHECK (reported_machine_count IS NULL OR reported_machine_count >= 0),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_vcpus <= total_vcpus),
  CHECK (reserved_memory_mb <= total_memory_mb),
  CHECK (reserved_disk_mb <= total_disk_mb)
);
CREATE INDEX hosts_schedulable_idx ON hosts (region_id, architecture, state, last_heartbeat_at);

CREATE TABLE host_heartbeats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  state host_state NOT NULL,
  available_vcpus integer NOT NULL CHECK (available_vcpus >= 0),
  available_memory_mb integer NOT NULL CHECK (available_memory_mb >= 0),
  available_disk_mb bigint NOT NULL CHECK (available_disk_mb >= 0),
  machine_count integer NOT NULL CHECK (machine_count >= 0),
  kvm_available boolean NOT NULL,
  daemon_version text NOT NULL
);
CREATE INDEX host_heartbeats_host_time_idx ON host_heartbeats (host_id, observed_at DESC);

CREATE TABLE machines (
  id text PRIMARY KEY CHECK (id ~ '^m_[a-zA-Z0-9_-]{12,}$'),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  host_id uuid REFERENCES hosts(id),
  host_machine_id text,
  lease_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  idempotency_key text,
  idempotency_request_hash text NOT NULL CHECK (idempotency_request_hash ~ '^[0-9a-f]{64}$'),
  state machine_state NOT NULL DEFAULT 'requested',
  state_reason text,
  region_id text NOT NULL REFERENCES regions(id),
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'aarch64')),
  template_id uuid,
  template_name text CHECK (template_name ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$'),
  source_oci_ref text,
  requested_ttl_seconds integer NOT NULL CHECK (requested_ttl_seconds BETWEEN 15 AND 86400),
  vcpus integer NOT NULL CHECK (vcpus > 0),
  memory_mb integer NOT NULL CHECK (memory_mb > 0),
  disk_mb bigint NOT NULL CHECK (disk_mb > 0),
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  placed_at timestamptz,
  started_at timestamptz,
  ready_at timestamptz,
  stopping_at timestamptz,
  stopped_at timestamptz,
  reservation_released_at timestamptz,
  usage_checkpoint_at timestamptz,
  usage_finalized_at timestamptz,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  UNIQUE (organization_id, project_id, idempotency_key),
  CHECK (num_nonnulls(template_id, template_name, source_oci_ref) = 1),
  CHECK ((ready = false AND ready_at IS NULL) OR (ready = true AND ready_at IS NOT NULL))
);
ALTER TABLE machines ADD CONSTRAINT machines_id_org_unique UNIQUE (id, organization_id);
CREATE INDEX machines_tenant_idx ON machines (organization_id, project_id, created_at DESC);
CREATE INDEX machines_host_active_idx ON machines (host_id, state) WHERE state NOT IN ('stopped', 'failed', 'lost');
CREATE INDEX machines_expiry_idx ON machines (expires_at) WHERE state NOT IN ('stopped', 'failed', 'lost');

CREATE TABLE machine_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  machine_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  from_state machine_state,
  to_state machine_state NOT NULL,
  reason text,
  observed_by text NOT NULL CHECK (observed_by IN ('control-plane', 'host', 'reconciler')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
	metadata jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (machine_id, organization_id) REFERENCES machines(id, organization_id)
);
CREATE INDEX machine_events_machine_time_idx ON machine_events (machine_id, occurred_at);

CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  operation text NOT NULL,
  request_hash bytea NOT NULL,
  response_status integer,
  response_body jsonb,
  resource_id text,
  locked_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation, key)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  host_template_name text NOT NULL UNIQUE
    CHECK (host_template_name ~ '^t-[a-f0-9]{29}$'),
  source_machine_id text,
  oci_reference text,
  manifest jsonb NOT NULL,
  object_key text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
	FOREIGN KEY (source_machine_id, organization_id) REFERENCES machines(id, organization_id),
  UNIQUE (project_id, name, version)
);
ALTER TABLE templates ADD CONSTRAINT templates_id_tenant_unique
  UNIQUE (id, organization_id, project_id);
ALTER TABLE machines ADD CONSTRAINT machines_template_fk
  FOREIGN KEY (template_id, organization_id, project_id)
  REFERENCES templates(id, organization_id, project_id);

CREATE TABLE template_replicas (
  template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  state template_replica_state NOT NULL DEFAULT 'requested',
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  verified_checksum text,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, host_id)
);

CREATE TABLE volumes (
  id text PRIMARY KEY CHECK (id ~ '^vol_[a-zA-Z0-9_-]{12,}$'),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  object_prefix text NOT NULL UNIQUE,
  size_limit_bytes bigint NOT NULL CHECK (size_limit_bytes > 0),
  observed_size_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id)
);
CREATE INDEX volumes_tenant_idx ON volumes (organization_id, project_id) WHERE deleted_at IS NULL;

CREATE TABLE usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  machine_id text,
  dimension text NOT NULL CHECK (dimension IN ('vcpu_seconds', 'gib_seconds', 'storage_gib_hours', 'egress_bytes', 'inference_units')),
  quantity numeric(30, 9) NOT NULL CHECK (quantity >= 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
	CHECK (period_end >= period_start),
	FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (machine_id, organization_id) REFERENCES machines(id, organization_id)
);
CREATE INDEX usage_events_tenant_time_idx ON usage_events (organization_id, period_start);

CREATE TABLE usage_outbox (
  event_key text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  machine_id text NOT NULL,
  vcpus integer NOT NULL CHECK (vcpus > 0),
  memory_mb integer NOT NULL CHECK (memory_mb > 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end >= period_start),
  final boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('control-plane', 'host', 'reconciler')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (machine_id, organization_id) REFERENCES machines(id, organization_id)
);
CREATE INDEX usage_outbox_pending_idx ON usage_outbox (created_at) WHERE processed_at IS NULL;

CREATE TABLE usage_daily (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  usage_date date NOT NULL,
  dimension text NOT NULL,
  quantity numeric(30, 9) NOT NULL CHECK (quantity >= 0),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, project_id, usage_date, dimension),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE billing_accounts (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'private_beta',
  stripe_customer_id text UNIQUE,
  spend_cap_cents integer CHECK (spend_cap_cents IS NULL OR spend_cap_cents >= 0),
  delinquent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload jsonb NOT NULL
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  organization_id uuid REFERENCES organizations(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'host', 'system')),
  actor_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  request_id text,
  ip inet,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (organization_id, occurred_at DESC);

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER machine_events_append_only BEFORE UPDATE OR DELETE ON machine_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON usage_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
