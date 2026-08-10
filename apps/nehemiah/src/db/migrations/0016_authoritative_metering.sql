-- Host-observed shadow metering. Prices remain disabled; these tables preserve
-- exact integer evidence and projections independently of the legacy ledger.

ALTER TABLE machines
  ADD COLUMN lease_generation bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT machines_lease_generation_positive CHECK (lease_generation > 0),
  ADD CONSTRAINT machines_meter_identity_unique
    UNIQUE (id, host_id, host_machine_id, lease_id, lease_generation);

CREATE TABLE host_usage_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id),
  machine_id text NOT NULL,
  host_machine_id text NOT NULL,
  lease_id uuid NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  host_boot_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('start', 'checkpoint', 'final')),
  runtime_ns numeric(30, 0) NOT NULL CHECK (
    runtime_ns BETWEEN 0 AND 18446744073709551615
  ),
  egress_bytes numeric(30, 0) NOT NULL CHECK (
    egress_bytes BETWEEN 0 AND 18446744073709551615
  ),
  egress_counter_epoch bigint NOT NULL CHECK (egress_counter_epoch > 0),
  observed_monotonic_ns numeric(30, 0) NOT NULL CHECK (
    observed_monotonic_ns BETWEEN 0 AND 18446744073709551615
  ),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  vcpus integer NOT NULL CHECK (vcpus > 0),
  memory_bytes bigint NOT NULL CHECK (memory_bytes > 0),
  process_id integer NOT NULL CHECK (process_id > 1),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  FOREIGN KEY (machine_id, host_id, host_machine_id, lease_id, lease_generation)
    REFERENCES machines(id, host_id, host_machine_id, lease_id, lease_generation),
  UNIQUE (id, machine_id, lease_id, lease_generation),
  UNIQUE (host_id, host_boot_id, lease_id, lease_generation, sequence)
);
CREATE INDEX host_usage_observations_lease_sequence_idx
  ON host_usage_observations (machine_id, lease_generation, sequence);
CREATE INDEX host_usage_observations_received_idx
  ON host_usage_observations (received_at, id);

CREATE TABLE machine_meter_state (
  machine_id text PRIMARY KEY REFERENCES machines(id),
  host_id uuid NOT NULL REFERENCES hosts(id),
  host_machine_id text NOT NULL,
  lease_id uuid NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  host_boot_id uuid NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_runtime_ns numeric(30, 0) NOT NULL DEFAULT 0 CHECK (
    last_runtime_ns BETWEEN 0 AND 18446744073709551615
  ),
  projected_runtime_ns numeric(30, 0) NOT NULL DEFAULT 0 CHECK (
    projected_runtime_ns BETWEEN 0 AND 18446744073709551615
  ),
  start_monotonic_ns numeric(30, 0) CHECK (
    start_monotonic_ns BETWEEN 0 AND 18446744073709551615
  ),
  last_observed_monotonic_ns numeric(30, 0) CHECK (
    last_observed_monotonic_ns BETWEEN 0 AND 18446744073709551615
  ),
  last_egress_bytes numeric(30, 0) NOT NULL DEFAULT 0 CHECK (
    last_egress_bytes BETWEEN 0 AND 18446744073709551615
  ),
  egress_counter_epoch bigint NOT NULL CHECK (egress_counter_epoch > 0),
  start_seen boolean NOT NULL DEFAULT false,
  final_seen boolean NOT NULL DEFAULT false,
  last_observed_at timestamptz,
  last_period_end timestamptz,
  last_received_at timestamptz,
  loss_closed_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text CHECK (
    quarantine_reason IS NULL OR quarantine_reason IN (
      'boot_id_changed', 'counter_reset', 'clock_skew', 'start_missing',
      'start_repeated', 'observation_after_final', 'payload_conflict'
    )
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (machine_id, host_id, host_machine_id, lease_id, lease_generation)
    REFERENCES machines(id, host_id, host_machine_id, lease_id, lease_generation),
  UNIQUE (host_id, host_boot_id, lease_id, lease_generation)
);
CREATE INDEX machine_meter_state_backlog_idx
  ON machine_meter_state (last_received_at)
  WHERE final_seen = false OR quarantined_at IS NOT NULL;

CREATE TABLE meter_raw_usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  observation_id bigint NOT NULL REFERENCES host_usage_observations(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL,
  machine_id text NOT NULL,
  lease_id uuid NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  dimension text NOT NULL CHECK (dimension IN ('compute', 'memory', 'egress')),
  unit text NOT NULL CHECK (unit IN ('vcpu_nanosecond', 'byte_nanosecond', 'byte')),
  quantity numeric(39, 0) NOT NULL CHECK (quantity >= 0),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end >= period_start),
  source text NOT NULL DEFAULT 'host' CHECK (source = 'host'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (observation_id, machine_id, lease_id, lease_generation)
    REFERENCES host_usage_observations(id, machine_id, lease_id, lease_generation),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  FOREIGN KEY (machine_id, organization_id) REFERENCES machines(id, organization_id),
  UNIQUE (observation_id, dimension, period_start)
);
CREATE INDEX meter_raw_usage_events_tenant_time_idx
  ON meter_raw_usage_events (organization_id, project_id, period_start, id);

CREATE TABLE metering_exceptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exception_key text NOT NULL UNIQUE,
  host_id uuid REFERENCES hosts(id),
  machine_id text REFERENCES machines(id),
  lease_id uuid,
  lease_generation bigint CHECK (lease_generation IS NULL OR lease_generation > 0),
  host_boot_id uuid,
  sequence bigint CHECK (sequence IS NULL OR sequence > 0),
  reason text NOT NULL CHECK (reason IN (
    'sequence_gap', 'payload_conflict', 'boot_id_changed', 'counter_reset',
    'clock_skew', 'start_missing', 'start_repeated',
    'observation_after_final', 'host_lost_without_final',
    'host_lost_without_observation'
  )),
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metering_exceptions_age_idx
  ON metering_exceptions (detected_at, id);

CREATE TABLE metering_exception_resolutions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exception_id bigint NOT NULL UNIQUE REFERENCES metering_exceptions(id),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  resolution text NOT NULL CHECK (length(resolution) BETWEEN 1 AND 512)
);

CREATE TRIGGER host_usage_observations_append_only
BEFORE UPDATE OR DELETE ON host_usage_observations
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER meter_raw_usage_events_append_only
BEFORE UPDATE OR DELETE ON meter_raw_usage_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER metering_exceptions_append_only
BEFORE UPDATE OR DELETE ON metering_exceptions
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER metering_exception_resolutions_append_only
BEFORE UPDATE OR DELETE ON metering_exception_resolutions
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
