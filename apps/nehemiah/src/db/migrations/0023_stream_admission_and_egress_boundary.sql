-- Private-beta managed networking is deliberately fail-closed until aggregate
-- traffic accounting exists. Refuse the rollout instead of silently changing a
-- live lease whose host policy might differ from the control-plane record.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM machines
    WHERE state NOT IN ('stopped', 'failed', 'lost')
      AND network_policy <> '{"mode":"off","hostnames":[],"cidrs":[]}'::jsonb
  ) THEN
    RAISE EXCEPTION
      'managed egress rollout requires every nonterminal machine to use mode=off';
  END IF;
END
$$;

ALTER TABLE machines
  ADD CONSTRAINT machines_nonterminal_egress_off_check CHECK (
    state IN ('stopped', 'failed', 'lost')
    OR network_policy = '{"mode":"off","hostnames":[],"cidrs":[]}'::jsonb
  );

ALTER TABLE organizations
  ADD COLUMN max_gateway_streams integer NOT NULL DEFAULT 32
    CHECK (max_gateway_streams BETWEEN 0 AND 10000),
  ADD COLUMN max_gateway_bandwidth_bps bigint NOT NULL DEFAULT 8388608
    CHECK (max_gateway_bandwidth_bps BETWEEN 0 AND 1099511627776);

ALTER TABLE projects
  ADD COLUMN max_gateway_streams integer NOT NULL DEFAULT 32
    CHECK (max_gateway_streams BETWEEN 0 AND 10000),
  ADD COLUMN max_gateway_bandwidth_bps bigint NOT NULL DEFAULT 8388608
    CHECK (max_gateway_bandwidth_bps BETWEEN 0 AND 1099511627776);

CREATE TABLE gateway_stream_leases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  authority_kind text NOT NULL CHECK (authority_kind IN ('machine_capability', 'volume_capability')),
  authority_id text NOT NULL CHECK (length(authority_id) BETWEEN 1 AND 255),
  gateway_instance_id text NOT NULL CHECK (length(gateway_instance_id) BETWEEN 1 AND 128),
  bandwidth_bytes_per_second bigint NOT NULL
    CHECK (bandwidth_bytes_per_second BETWEEN 1 AND 1073741824),
  acquired_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  UNIQUE (id, organization_id, project_id),
  CHECK (expires_at > acquired_at)
);

CREATE INDEX gateway_stream_leases_org_active_idx
  ON gateway_stream_leases (organization_id, expires_at);
CREATE INDEX gateway_stream_leases_project_active_idx
  ON gateway_stream_leases (project_id, expires_at);
CREATE INDEX gateway_stream_leases_authority_idx
  ON gateway_stream_leases (authority_kind, authority_id, expires_at);

COMMENT ON TABLE gateway_stream_leases IS
  'Short-TTL global org/project stream and reserved-bandwidth admission shared by every gateway and volume broker replica.';
COMMENT ON COLUMN organizations.max_gateway_bandwidth_bps IS
  'Aggregate reserved bytes/second across every active gateway and volume stream in the organization.';
COMMENT ON COLUMN projects.max_gateway_bandwidth_bps IS
  'Aggregate reserved bytes/second across every active gateway and volume stream in the project.';
