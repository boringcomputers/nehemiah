ALTER TABLE machines
  ADD COLUMN network_policy jsonb NOT NULL
  DEFAULT '{"mode":"off","hostnames":[],"cidrs":[]}'::jsonb;

ALTER TABLE machines
  ADD CONSTRAINT machines_network_policy_shape_check CHECK (
    jsonb_typeof(network_policy) = 'object'
    AND network_policy ? 'mode'
    AND network_policy ? 'hostnames'
    AND network_policy ? 'cidrs'
	AND network_policy - ARRAY['mode', 'hostnames', 'cidrs'] = '{}'::jsonb
    AND network_policy->>'mode' IN ('off', 'allowlist')
    AND jsonb_typeof(network_policy->'hostnames') = 'array'
    AND jsonb_typeof(network_policy->'cidrs') = 'array'
    AND jsonb_array_length(network_policy->'hostnames') <= 64
    AND jsonb_array_length(network_policy->'cidrs') <= 64
    AND (
      (network_policy->>'mode' = 'off'
       AND jsonb_array_length(network_policy->'hostnames') = 0
       AND jsonb_array_length(network_policy->'cidrs') = 0)
      OR
      (network_policy->>'mode' = 'allowlist'
       AND jsonb_array_length(network_policy->'hostnames')
           + jsonb_array_length(network_policy->'cidrs') > 0)
    )
  );

COMMENT ON COLUMN machines.network_policy IS
  'Canonical managed guest egress intent. The host enforces an immutable deny floor over every allowlist.';
