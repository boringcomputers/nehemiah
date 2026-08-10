ALTER TABLE audit_events
  ADD COLUMN operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN project_id uuid,
  ADD COLUMN outcome text NOT NULL DEFAULT 'succeeded',
  ADD COLUMN reason_code text;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_project_tenant_fk
    FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT audit_events_outcome_check
    CHECK (outcome IN ('requested', 'succeeded', 'failed', 'denied')),
  ADD CONSTRAINT audit_events_reason_code_check
    CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9._:-]{0,127}$');

CREATE INDEX audit_events_operation_idx ON audit_events (operation_id, occurred_at);
CREATE INDEX audit_events_project_time_idx
  ON audit_events (organization_id, project_id, occurred_at DESC);
