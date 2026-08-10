CREATE TABLE machine_gateway_grants (
  id uuid PRIMARY KEY,
  machine_id text NOT NULL,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability = 'preview'),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (machine_id, organization_id)
    REFERENCES machines(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

-- Resolution supplies the signed capability identity and exact preview port.
-- Including every binding in this index keeps the authorization lookup narrow;
-- the machine join separately proves that the lease is still current.
CREATE INDEX machine_gateway_grants_resolution_idx
  ON machine_gateway_grants
    (id, machine_id, lease_id, capability, port, expires_at);

CREATE INDEX machine_gateway_grants_expiry_idx
  ON machine_gateway_grants (expires_at, id);
