#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const cutoverIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

const object = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value, expected) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

const invariant = (condition, message) => {
  if (!condition)
    throw new Error(`invalid deployment cutover acknowledgement: ${message}`);
};

const expectedInputs = (input) => {
  invariant(
    digestPattern.test(input.controlDigest ?? ""),
    "invalid expected control digest",
  );
  invariant(
    digestPattern.test(input.gatewayDigest ?? ""),
    "invalid expected gateway digest",
  );
  invariant(
    migrationPattern.test(input.schemaEpoch ?? ""),
    "invalid expected schema epoch",
  );
  return input;
};

export const validatePreparedCutover = (candidate, input) => {
  const expected = expectedInputs(input);
  invariant(object(candidate), "prepare response is not an object");
  invariant(
    exactKeys(candidate, [
      "active_streams",
      "candidate_control_digest",
      "candidate_gateway_digest",
      "control_replicas",
      "cutover_id",
      "database_writes_fenced",
      "gateway_replicas",
      "schema_epoch",
      "state",
    ]),
    "prepare response has an unexpected shape",
  );
  invariant(
    candidate.state === "maintenance",
    "controller is not in maintenance state",
  );
  invariant(
    cutoverIdPattern.test(candidate.cutover_id),
    "cutover_id is not a UUIDv4",
  );
  invariant(
    candidate.schema_epoch === expected.schemaEpoch,
    "schema epoch does not match",
  );
  invariant(
    candidate.candidate_control_digest === expected.controlDigest,
    "control digest does not match",
  );
  invariant(
    candidate.candidate_gateway_digest === expected.gatewayDigest,
    "gateway digest does not match",
  );
  invariant(
    candidate.control_replicas === 0,
    "a prior control-plane replica is still active",
  );
  invariant(
    candidate.gateway_replicas === 0,
    "a prior gateway replica is still active",
  );
  invariant(
    candidate.active_streams === 0,
    "a prior gateway stream is still active",
  );
  invariant(
    candidate.database_writes_fenced === true,
    "prior database writers are not fenced",
  );
  return candidate.cutover_id;
};

export const validateCommittedCutover = (candidate, input) => {
  const expected = expectedInputs(input);
  invariant(object(candidate), "commit response is not an object");
  invariant(
    exactKeys(candidate, [
      "control_digest",
      "cutover_id",
      "gateway_digest",
      "schema_epoch",
      "state",
    ]),
    "commit response has an unexpected shape",
  );
  invariant(candidate.state === "deployed", "candidate is not deployed");
  invariant(
    candidate.cutover_id === expected.cutoverId,
    "cutover_id does not match",
  );
  invariant(
    candidate.schema_epoch === expected.schemaEpoch,
    "schema epoch does not match",
  );
  invariant(
    candidate.control_digest === expected.controlDigest,
    "control digest does not match",
  );
  invariant(
    candidate.gateway_digest === expected.gatewayDigest,
    "gateway digest does not match",
  );
  return candidate.cutover_id;
};

const run = async () => {
  const [mode, responsePath] = process.argv.slice(2);
  invariant(
    mode === "prepare" || mode === "commit",
    "mode must be prepare or commit",
  );
  invariant(
    typeof responsePath === "string" && responsePath.length > 0,
    "response file is required",
  );
  const raw = await readFile(responsePath, "utf8");
  invariant(Buffer.byteLength(raw) <= 16_384, "response exceeds 16 KiB");
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error(
      "invalid deployment cutover acknowledgement: response is not JSON",
    );
  }
  const input = {
    controlDigest: process.env.CONTROL_DIGEST,
    gatewayDigest: process.env.GATEWAY_DIGEST,
    schemaEpoch: process.env.SCHEMA_EPOCH,
    cutoverId: process.env.CUTOVER_ID,
  };
  const id =
    mode === "prepare"
      ? validatePreparedCutover(candidate, input)
      : validateCommittedCutover(candidate, input);
  process.stdout.write(`${id}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
