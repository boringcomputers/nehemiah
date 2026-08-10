-- A credentialed host is still an untrusted cost producer. Bound durable batch
-- cadence and pending sequence space before immutable evidence is inserted;
-- one coalesced exception quarantines a host that violates the window.

ALTER TABLE hosts
  ADD COLUMN last_metering_batch_at timestamptz,
  ADD COLUMN metering_quarantined_at timestamptz;

ALTER TABLE machine_meter_state
  DROP CONSTRAINT machine_meter_state_quarantine_reason_check,
  ADD CONSTRAINT machine_meter_state_quarantine_reason_check CHECK (
    quarantine_reason IS NULL OR quarantine_reason IN (
      'boot_id_changed', 'counter_reset', 'clock_skew', 'start_missing',
      'start_repeated', 'observation_after_final', 'payload_conflict',
      'degraded_terminal', 'sequence_window_exceeded'
    )
  );

ALTER TABLE metering_exceptions
  DROP CONSTRAINT metering_exceptions_reason_check,
  ADD CONSTRAINT metering_exceptions_reason_check CHECK (reason IN (
    'sequence_gap', 'payload_conflict', 'boot_id_changed', 'counter_reset',
    'clock_skew', 'start_missing', 'start_repeated',
    'observation_after_final', 'host_lost_without_final',
    'host_lost_without_observation', 'degraded_terminal',
    'sequence_window_exceeded'
  ));

CREATE INDEX host_usage_observations_pending_admission_idx
  ON host_usage_observations (host_id, machine_id, lease_generation, sequence);

COMMENT ON COLUMN hosts.last_metering_batch_at IS
  'Durable cross-replica admission timestamp for bounded host metering batches.';
COMMENT ON COLUMN hosts.metering_quarantined_at IS
  'First durable metering-integrity quarantine time; operator review is required.';
