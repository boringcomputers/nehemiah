import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  validateCommittedCutover,
  validatePreparedCutover,
} from "./cutover-response.mjs";

const input = {
  controlDigest: `sha256:${"a".repeat(64)}`,
  gatewayDigest: `sha256:${"b".repeat(64)}`,
  schemaEpoch: "0024_stripe_legacy_delinquency_guard.sql",
  cutoverId: "9b2c8bea-f475-4db9-bc70-0e6677df58a6",
};

const prepared = () => ({
  state: "maintenance",
  cutover_id: input.cutoverId,
  schema_epoch: input.schemaEpoch,
  candidate_control_digest: input.controlDigest,
  candidate_gateway_digest: input.gatewayDigest,
  control_replicas: 0,
  gateway_replicas: 0,
  active_streams: 0,
  database_writes_fenced: true,
});

test("accepts only a fully fenced maintenance acknowledgement", () => {
  assert.equal(validatePreparedCutover(prepared(), input), input.cutoverId);
  for (const [field, value] of [
    ["control_replicas", 1],
    ["gateway_replicas", 1],
    ["active_streams", 1],
    ["database_writes_fenced", false],
  ]) {
    const candidate = prepared();
    candidate[field] = value;
    assert.throws(() => validatePreparedCutover(candidate, input));
  }
});

test("rejects substituted candidates and unexpected acknowledgement fields", () => {
  assert.throws(() =>
    validatePreparedCutover(
      { ...prepared(), candidate_control_digest: `sha256:${"c".repeat(64)}` },
      input,
    ),
  );
  assert.throws(() =>
    validatePreparedCutover({ ...prepared(), note: "trust me" }, input),
  );
});

test("binds the committed deployment to the same cutover, schema, and digests", () => {
  const committed = {
    state: "deployed",
    cutover_id: input.cutoverId,
    schema_epoch: input.schemaEpoch,
    control_digest: input.controlDigest,
    gateway_digest: input.gatewayDigest,
  };
  assert.equal(validateCommittedCutover(committed, input), input.cutoverId);
  assert.throws(() =>
    validateCommittedCutover({ ...committed, cutover_id: randomUUID() }, input),
  );
  assert.throws(() =>
    validateCommittedCutover(
      { ...committed, schema_epoch: "0023_other.sql" },
      input,
    ),
  );
});
