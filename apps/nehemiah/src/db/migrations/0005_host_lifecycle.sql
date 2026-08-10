CREATE TYPE host_desired_state AS ENUM ('active', 'draining', 'quarantined', 'revoked');
CREATE TYPE host_credential_status AS ENUM ('active', 'revoked');

ALTER TABLE hosts
  ALTER COLUMN credential_hash DROP NOT NULL,
  ALTER COLUMN control_credential_ciphertext DROP NOT NULL,
  ALTER COLUMN gateway_credential_ciphertext DROP NOT NULL,
  ADD COLUMN desired_state host_desired_state NOT NULL DEFAULT 'active',
  ADD COLUMN credential_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN credential_status host_credential_status NOT NULL DEFAULT 'active',
  ADD COLUMN credential_rotated_at timestamptz,
  ADD COLUMN credential_revoked_at timestamptz,
  ADD COLUMN enrollment_completed_at timestamptz,
  ADD COLUMN lifecycle_reason text,
  ADD COLUMN lifecycle_updated_at timestamptz NOT NULL DEFAULT now();

UPDATE hosts
SET desired_state = CASE
      WHEN state = 'draining' THEN 'draining'::host_desired_state
      ELSE 'active'::host_desired_state
    END,
    credential_rotated_at = created_at,
    enrollment_completed_at = last_heartbeat_at,
    lifecycle_updated_at = updated_at;

ALTER TABLE hosts
  ALTER COLUMN credential_rotated_at SET NOT NULL,
  ALTER COLUMN credential_rotated_at SET DEFAULT now(),
  ADD CONSTRAINT hosts_credential_generation_positive CHECK (credential_generation > 0),
  ADD CONSTRAINT hosts_credential_material_matches_status CHECK (
    (credential_status = 'active'
      AND credential_hash IS NOT NULL
      AND control_credential_ciphertext IS NOT NULL
      AND gateway_credential_ciphertext IS NOT NULL
      AND credential_revoked_at IS NULL)
    OR
    (credential_status = 'revoked'
      AND credential_hash IS NULL
      AND control_credential_ciphertext IS NULL
      AND gateway_credential_ciphertext IS NULL
      AND credential_revoked_at IS NOT NULL)
  ),
  ADD CONSTRAINT hosts_lifecycle_reason_bounded CHECK (
    lifecycle_reason IS NULL OR length(lifecycle_reason) BETWEEN 1 AND 512
  ),
  ADD CONSTRAINT hosts_revoked_state_is_terminal CHECK (
    desired_state <> 'revoked' OR credential_status = 'revoked'
  );

CREATE INDEX hosts_lifecycle_idx
  ON hosts (desired_state, credential_status, region_id, architecture, last_heartbeat_at);

-- Fleet administration is global infrastructure authority. Tenant organization
-- administrators are not operators unless their organization is explicitly present here.
CREATE TABLE fleet_operator_organizations (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE host_heartbeats ADD COLUMN credential_generation integer;

UPDATE host_heartbeats heartbeat
SET credential_generation = host.credential_generation
FROM hosts host
WHERE host.id = heartbeat.host_id;

ALTER TABLE host_heartbeats
  ALTER COLUMN credential_generation SET NOT NULL,
  ADD CONSTRAINT host_heartbeats_credential_generation_positive
    CHECK (credential_generation > 0);
