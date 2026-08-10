-- Capability streams already have global concurrent-lease and bandwidth
-- admission. This second, fixed-cardinality window bounds resolver/lease churn
-- even when a valid capability is replayed sequentially across gateway replicas.
-- Only keyed hash slots are retained; no bearer, client address, or capability
-- identifier is persisted in this table.
CREATE TABLE gateway_capability_request_windows (
  scope text NOT NULL CHECK (scope IN ('authority', 'project', 'organization')),
  bucket_slot integer NOT NULL CHECK (bucket_slot >= 0 AND bucket_slot < 1048576),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 1000001),
  PRIMARY KEY (scope, bucket_slot)
);

COMMENT ON TABLE gateway_capability_request_windows IS
  'Bounded, collision-conservative request admission for capability route resolution across every gateway replica.';
