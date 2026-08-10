-- Reject impossible or excessively frequent host evidence without rewriting
-- the append-only ledger. A pre-upgrade exact final on a nonterminal lease is
-- ambiguous and must be resolved before this security boundary can roll out.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM machines machine
    JOIN machine_meter_state meter ON meter.machine_id = machine.id
    WHERE machine.state NOT IN ('stopped', 'failed', 'lost')
      AND meter.final_seen
      AND meter.quarantine_reason IS DISTINCT FROM 'degraded_terminal'
  ) THEN
    RAISE EXCEPTION
      'cannot enable metering integrity bounds while a nonterminal lease has an exact final';
  END IF;
END
$$;

ALTER TABLE machine_meter_state
  DROP CONSTRAINT machine_meter_state_quarantine_reason_check,
  ADD CONSTRAINT machine_meter_state_quarantine_reason_check CHECK (
    quarantine_reason IS NULL OR quarantine_reason IN (
      'boot_id_changed', 'counter_reset', 'clock_skew', 'start_missing',
      'start_repeated', 'observation_after_final', 'payload_conflict',
      'degraded_terminal', 'sequence_window_exceeded',
      'observation_rate_exceeded', 'egress_plausibility_exceeded',
      'premature_final'
    )
  );

ALTER TABLE metering_exceptions
  DROP CONSTRAINT metering_exceptions_reason_check,
  ADD CONSTRAINT metering_exceptions_reason_check CHECK (reason IN (
    'sequence_gap', 'payload_conflict', 'boot_id_changed', 'counter_reset',
    'clock_skew', 'start_missing', 'start_repeated',
    'observation_after_final', 'host_lost_without_final',
    'host_lost_without_observation', 'degraded_terminal',
    'sequence_window_exceeded', 'observation_rate_exceeded',
    'egress_plausibility_exceeded', 'premature_final'
  ));
