-- A refresh family is a long-lived bearer authority, but it must not also be
-- an unbounded database/WAL producer.  Runtime code enforces a durable
-- minimum cadence under the family row lock; this constraint is the final
-- fail-closed ceiling if a future writer bypasses that code.

ALTER TABLE device_refresh_tokens
  ADD CONSTRAINT device_refresh_tokens_generation_ceiling_check
  CHECK (generation BETWEEN 0 AND 4095);

CREATE INDEX device_refresh_tokens_expired_retention_idx
  ON device_refresh_tokens (expires_at, family_id, generation);

CREATE INDEX device_access_tokens_expired_retention_idx
  ON device_access_tokens (expires_at, family_id, id);

COMMENT ON CONSTRAINT device_refresh_tokens_generation_ceiling_check
  ON device_refresh_tokens IS
  'At most 4096 refresh/access generations may be issued by one 30-day family; reauthentication is required afterward.';
