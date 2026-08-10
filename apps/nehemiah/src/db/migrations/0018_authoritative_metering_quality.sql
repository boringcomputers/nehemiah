-- Make terminal observations distinguish a complete sample from a forced close
-- at the last defensible persisted high-water. Existing pre-contract finals are
-- conservatively surfaced as open exceptions during the additive upgrade.

ALTER TABLE host_usage_observations
  ADD COLUMN quality text NOT NULL DEFAULT 'exact',
  ADD COLUMN quality_reason text NOT NULL DEFAULT 'none',
  ADD CONSTRAINT host_usage_observations_quality_check
    CHECK (quality IN ('exact', 'last_defensible')),
  ADD CONSTRAINT host_usage_observations_quality_reason_check
    CHECK (quality_reason IN (
      'none', 'terminal_monotonic_unavailable', 'terminal_monotonic_regressed',
      'terminal_egress_unavailable', 'invalid_or_expired_state',
      'runtime_unavailable', 'host_boot_changed', 'network_isolation_unavailable'
    )),
  ADD CONSTRAINT host_usage_observations_quality_consistent CHECK (
    (quality = 'exact' AND quality_reason = 'none') OR
    (quality = 'last_defensible' AND kind = 'final' AND quality_reason <> 'none')
  );

-- Do not let a pre-0018 binary silently manufacture a clean terminal after the
-- migration. The new protocol supplies both fields explicitly.
ALTER TABLE host_usage_observations
  ALTER COLUMN quality DROP DEFAULT,
  ALTER COLUMN quality_reason DROP DEFAULT;

ALTER TABLE machine_meter_state
  DROP CONSTRAINT machine_meter_state_quarantine_reason_check,
  ADD CONSTRAINT machine_meter_state_quarantine_reason_check CHECK (
    quarantine_reason IS NULL OR quarantine_reason IN (
      'boot_id_changed', 'counter_reset', 'clock_skew', 'start_missing',
      'start_repeated', 'observation_after_final', 'payload_conflict',
      'degraded_terminal'
    )
  );

ALTER TABLE metering_exceptions
  DROP CONSTRAINT metering_exceptions_reason_check,
  ADD CONSTRAINT metering_exceptions_reason_check CHECK (reason IN (
    'sequence_gap', 'payload_conflict', 'boot_id_changed', 'counter_reset',
    'clock_skew', 'start_missing', 'start_repeated',
    'observation_after_final', 'host_lost_without_final',
    'host_lost_without_observation', 'degraded_terminal'
  ));

INSERT INTO metering_exceptions
 (exception_key, host_id, machine_id, lease_id, lease_generation,
  host_boot_id, sequence, reason)
SELECT 'meter:migration:0018:pre_quality_final:' || observation.id,
       observation.host_id, observation.machine_id, observation.lease_id,
       observation.lease_generation, observation.host_boot_id,
       observation.sequence, 'degraded_terminal'
FROM host_usage_observations observation
WHERE observation.kind = 'final'
ON CONFLICT (exception_key) DO NOTHING;

UPDATE machine_meter_state state
SET quarantined_at = COALESCE(state.quarantined_at, now()),
    quarantine_reason = COALESCE(state.quarantine_reason, 'degraded_terminal'),
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM host_usage_observations observation
  WHERE observation.machine_id = state.machine_id
    AND observation.lease_generation = state.lease_generation
    AND observation.kind = 'final'
);
