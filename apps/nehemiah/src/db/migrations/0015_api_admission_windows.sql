-- Global REST admission state is deliberately stored in a fixed slot space.
-- PostgreSQL is shared by every control-plane replica, while the 20-bit slot
-- prevents attacker-controlled credentials or addresses from creating an
-- unbounded number of rows. Hash collisions only make admission more
-- conservative; they can never grant additional requests.
CREATE TABLE api_admission_windows (
  scope text NOT NULL CHECK (scope IN (
    'preauth_ip',
    'preauth_api_key',
    'principal',
    'organization',
    'project'
  )),
  bucket_slot integer NOT NULL CHECK (bucket_slot >= 0 AND bucket_slot < 1048576),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1 AND request_count <= 1000001),
  PRIMARY KEY (scope, bucket_slot)
);

COMMENT ON TABLE api_admission_windows IS
  'Bounded, collision-conservative fixed-window REST admission state; contains no credential or client-address material.';
