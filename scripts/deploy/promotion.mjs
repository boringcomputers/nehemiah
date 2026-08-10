#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { appendFile, open, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROMOTION_SCHEMA_VERSION = 1;
export const STAGING_WORKFLOW_PATH = ".github/workflows/deploy-staging.yml";
export const STAGING_EVENT = "workflow_dispatch";
export const PROTECTED_BRANCH = "main";
export const PROTECTED_REF = `refs/heads/${PROTECTED_BRANCH}`;
export const PROMOTION_FILE = "promotion.json";
export const MAX_PROMOTION_BYTES = 4_096;
export const MAX_PROMOTION_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const runIdPattern = /^[1-9][0-9]{0,19}$/;
const repositoryPattern =
  /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.-]{1,100}\/(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9_.-]{1,100}$/;
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const githubTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

const promotionKeys = [
  "schema_version",
  "repository",
  "workflow_path",
  "run_id",
  "run_attempt",
  "event",
  "head_branch",
  "head_sha",
  "ref",
  "schema_epoch",
  "control_digest",
  "gateway_digest",
];

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
  if (!condition) throw new Error(`invalid staging promotion: ${message}`);
};

const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

const expectedInputs = (input, { requireSchema = false } = {}) => {
  invariant(
    repositoryPattern.test(input.repository ?? ""),
    "invalid expected repository",
  );
  invariant(runIdPattern.test(input.runId ?? ""), "invalid expected run id");
  invariant(shaPattern.test(input.headSha ?? ""), "invalid expected head SHA");
  const apiUrl = new URL(input.apiUrl ?? "https://api.github.com");
  invariant(apiUrl.protocol === "https:", "GitHub API URL must use HTTPS");
  invariant(
    apiUrl.username === "" &&
      apiUrl.password === "" &&
      apiUrl.search === "" &&
      apiUrl.hash === "",
    "invalid GitHub API URL",
  );
  input.apiUrl = apiUrl.href.replace(/\/$/, "");
  if (requireSchema) {
    invariant(
      migrationPattern.test(input.schemaEpoch ?? ""),
      "invalid expected schema epoch",
    );
  }
  return input;
};

const parseRunAttempt = (value) => {
  const candidate = Number(value);
  invariant(
    Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= 1_000,
    "invalid run attempt",
  );
  return candidate;
};

const parseTimestamp = (value, label) => {
  const match =
    typeof value === "string" ? value.match(githubTimestampPattern) : null;
  invariant(match !== null, `invalid workflow ${label}`);
  const timestamp = Date.parse(value);
  const milliseconds = (match[2] ?? "000").padEnd(3, "0");
  invariant(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString() === `${match[1]}.${milliseconds}Z`,
    `invalid workflow ${label}`,
  );
  return timestamp;
};

export const promotionArtifactName = (runId, runAttempt) => {
  invariant(runIdPattern.test(runId ?? ""), "invalid run id");
  return `staging-promotion-${runId}-${parseRunAttempt(runAttempt)}`;
};

export const createPromotion = (input) => {
  const expected = expectedInputs(
    {
      repository: input.repository,
      runId: input.runId,
      headSha: input.headSha,
      schemaEpoch: input.schemaEpoch,
      apiUrl: "https://api.github.com",
    },
    { requireSchema: true },
  );
  invariant(
    digestPattern.test(input.controlDigest ?? ""),
    "invalid control digest",
  );
  invariant(
    digestPattern.test(input.gatewayDigest ?? ""),
    "invalid gateway digest",
  );
  const candidate = {
    schema_version: PROMOTION_SCHEMA_VERSION,
    repository: expected.repository,
    workflow_path: STAGING_WORKFLOW_PATH,
    run_id: expected.runId,
    run_attempt: parseRunAttempt(input.runAttempt),
    event: STAGING_EVENT,
    head_branch: PROTECTED_BRANCH,
    head_sha: expected.headSha,
    ref: PROTECTED_REF,
    schema_epoch: expected.schemaEpoch,
    control_digest: input.controlDigest,
    gateway_digest: input.gatewayDigest,
  };
  validatePromotion(candidate, {
    ...expected,
    runAttempt: candidate.run_attempt,
    controlDigest: input.controlDigest,
    gatewayDigest: input.gatewayDigest,
  });
  return candidate;
};

export const validateRunEvidence = (
  { run, branch, artifactListing },
  input,
) => {
  const expected = expectedInputs({ ...input });
  invariant(object(run), "workflow run response is not an object");
  invariant(
    positiveSafeInteger(run.id) && String(run.id) === expected.runId,
    "workflow run id does not match",
  );
  invariant(
    run.path === STAGING_WORKFLOW_PATH,
    "workflow path is not the staging deployment workflow",
  );
  invariant(
    run.event === STAGING_EVENT,
    "workflow event is not manual dispatch",
  );
  invariant(
    run.head_branch === PROTECTED_BRANCH,
    "workflow did not run on main",
  );
  invariant(
    run.head_sha === expected.headSha,
    "workflow head SHA does not match",
  );
  invariant(run.status === "completed", "workflow run is not completed");
  invariant(run.conclusion === "success", "workflow run did not succeed");
  invariant(
    object(run.repository) && run.repository.full_name === expected.repository,
    "workflow repository does not match",
  );
  invariant(
    object(run.head_repository) &&
      run.head_repository.full_name === expected.repository,
    "workflow head repository does not match",
  );
  const now = input.nowMs ?? Date.now();
  invariant(
    Number.isSafeInteger(now) && now > 0,
    "invalid promotion validation time",
  );
  const createdAt = parseTimestamp(run.created_at, "creation time");
  const completedAt = parseTimestamp(run.updated_at, "completion time");
  invariant(
    createdAt <= completedAt,
    "workflow completion predates its creation",
  );
  invariant(
    createdAt <= now + MAX_CLOCK_SKEW_MS &&
      completedAt <= now + MAX_CLOCK_SKEW_MS,
    "workflow timestamps are in the future",
  );
  invariant(
    now - createdAt <= MAX_PROMOTION_AGE_MS &&
      now - completedAt <= MAX_PROMOTION_AGE_MS,
    "successful staging evidence is older than 24 hours",
  );
  const runAttempt = parseRunAttempt(run.run_attempt);

  invariant(object(branch), "branch response is not an object");
  invariant(branch.name === PROTECTED_BRANCH, "branch is not main");
  invariant(branch.protected === true, "main is not protected");
  invariant(
    object(branch.commit) && branch.commit.sha === expected.headSha,
    "protected main no longer points at the reviewed SHA",
  );

  invariant(object(artifactListing), "artifact response is not an object");
  invariant(
    Number.isSafeInteger(artifactListing.total_count) &&
      artifactListing.total_count >= 1 &&
      artifactListing.total_count <= 100,
    "artifact count is outside the bounded range",
  );
  invariant(
    Array.isArray(artifactListing.artifacts),
    "artifacts is not an array",
  );
  invariant(
    artifactListing.artifacts.length === artifactListing.total_count,
    "artifact response is incomplete",
  );
  const name = promotionArtifactName(expected.runId, runAttempt);
  const promotionArtifacts = artifactListing.artifacts.filter(
    (artifact) =>
      object(artifact) && artifact.name?.startsWith("staging-promotion-"),
  );
  invariant(
    promotionArtifacts.length === 1 && promotionArtifacts[0].name === name,
    "expected exactly one run-scoped promotion artifact",
  );
  const artifact = promotionArtifacts[0];
  invariant(positiveSafeInteger(artifact.id), "invalid promotion artifact id");
  invariant(artifact.expired === false, "promotion artifact is expired");
  invariant(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes >= 1 &&
      artifact.size_in_bytes <= 16_384,
    "promotion artifact archive exceeds 16 KiB",
  );
  invariant(
    object(artifact.workflow_run) &&
      positiveSafeInteger(artifact.workflow_run.id) &&
      String(artifact.workflow_run.id) === expected.runId &&
      artifact.workflow_run.head_branch === PROTECTED_BRANCH &&
      artifact.workflow_run.head_sha === expected.headSha,
    "promotion artifact is not bound to the reviewed staging run",
  );
  invariant(
    artifact.archive_download_url ===
      `${expected.apiUrl}/repos/${expected.repository}/actions/artifacts/${artifact.id}/zip`,
    "promotion artifact download URL does not match",
  );
  if (artifact.digest !== undefined) {
    invariant(
      digestPattern.test(artifact.digest),
      "promotion archive digest is invalid",
    );
  }
  return {
    artifactId: String(artifact.id),
    artifactName: name,
    runAttempt,
  };
};

export const validatePromotion = (candidate, input) => {
  const expected = expectedInputs({ ...input }, { requireSchema: true });
  const runAttempt = parseRunAttempt(input.runAttempt);
  invariant(object(candidate), "promotion record is not an object");
  invariant(
    exactKeys(candidate, promotionKeys),
    "promotion record has an unexpected shape",
  );
  invariant(
    candidate.schema_version === PROMOTION_SCHEMA_VERSION,
    "unsupported promotion schema version",
  );
  invariant(
    candidate.repository === expected.repository,
    "repository does not match",
  );
  invariant(
    candidate.workflow_path === STAGING_WORKFLOW_PATH,
    "workflow path does not match",
  );
  invariant(candidate.run_id === expected.runId, "run id does not match");
  invariant(candidate.run_attempt === runAttempt, "run attempt does not match");
  invariant(candidate.event === STAGING_EVENT, "event does not match");
  invariant(
    candidate.head_branch === PROTECTED_BRANCH,
    "head branch does not match",
  );
  invariant(candidate.head_sha === expected.headSha, "head SHA does not match");
  invariant(candidate.ref === PROTECTED_REF, "ref does not match");
  invariant(
    candidate.schema_epoch === expected.schemaEpoch,
    "schema epoch does not match",
  );
  invariant(
    digestPattern.test(candidate.control_digest),
    "invalid control digest",
  );
  invariant(
    digestPattern.test(candidate.gateway_digest),
    "invalid gateway digest",
  );
  if (input.controlDigest !== undefined) {
    invariant(
      digestPattern.test(input.controlDigest) &&
        candidate.control_digest === input.controlDigest,
      "control digest does not match",
    );
  }
  if (input.gatewayDigest !== undefined) {
    invariant(
      digestPattern.test(input.gatewayDigest) &&
        candidate.gateway_digest === input.gatewayDigest,
      "gateway digest does not match",
    );
  }
  invariant(
    candidate.control_digest !== candidate.gateway_digest,
    "control and gateway digests must differ",
  );
  return candidate;
};

const readBoundedJson = async (file, maximum, label) => {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let raw;
  try {
    const info = await handle.stat({ bigint: true });
    invariant(
      info.isFile() && info.nlink === 1n,
      `${label} is not a single-link regular file`,
    );
    invariant(
      info.size >= 1n && info.size <= BigInt(maximum),
      `${label} exceeds its size bound`,
    );
    raw = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    invariant(
      BigInt(raw.length) === info.size &&
        after.dev === info.dev &&
        after.ino === info.ino &&
        after.size === info.size &&
        after.mtimeNs === info.mtimeNs &&
        after.ctimeNs === info.ctimeNs,
      `${label} changed while being read`,
    );
  } finally {
    await handle.close();
  }
  const text = raw.toString("utf8");
  invariant(
    Buffer.from(text, "utf8").equals(raw),
    `${label} is not valid UTF-8`,
  );
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error(`invalid staging promotion: ${label} is not JSON`);
  }
  return { candidate, text };
};

export const readPromotionDirectory = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  invariant(
    entries.length === 1 &&
      entries[0].name === PROMOTION_FILE &&
      entries[0].isFile() &&
      !entries[0].isSymbolicLink(),
    "promotion artifact must contain only promotion.json",
  );
  const file = path.join(directory, PROMOTION_FILE);
  const { candidate, text } = await readBoundedJson(
    file,
    MAX_PROMOTION_BYTES,
    "promotion.json",
  );
  invariant(
    text === `${JSON.stringify(candidate, null, 2)}\n`,
    "promotion.json is not canonical JSON",
  );
  return candidate;
};

const writeOutputs = async (values) => {
  for (const [name, value] of Object.entries(values)) {
    invariant(/^[a-z_]+$/.test(name), "invalid output name");
    invariant(
      typeof value === "string" && /^[A-Za-z0-9_./:@-]+$/.test(value),
      `invalid ${name} output`,
    );
  }
  const serialized = Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    process.stdout.write(serialized);
  }
};

const loadEvidence = async (runPath, branchPath, artifactsPath) => {
  const [
    { candidate: run },
    { candidate: branch },
    { candidate: artifactListing },
  ] = await Promise.all([
    readBoundedJson(runPath, 131_072, "workflow run response"),
    readBoundedJson(branchPath, 65_536, "branch response"),
    readBoundedJson(artifactsPath, 131_072, "artifact response"),
  ]);
  return { run, branch, artifactListing };
};

const cliExpected = (requireSchema = false) =>
  expectedInputs(
    {
      repository: process.env.EXPECTED_REPOSITORY,
      runId: process.env.EXPECTED_RUN_ID,
      headSha: process.env.EXPECTED_HEAD_SHA,
      schemaEpoch: process.env.EXPECTED_SCHEMA_EPOCH,
      apiUrl: process.env.GITHUB_API_URL,
    },
    { requireSchema },
  );

const run = async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "create") {
    invariant(args.length === 1, "create requires one output path");
    const candidate = createPromotion({
      repository: process.env.PROMOTION_REPOSITORY,
      runId: process.env.PROMOTION_RUN_ID,
      runAttempt: process.env.PROMOTION_RUN_ATTEMPT,
      headSha: process.env.PROMOTION_HEAD_SHA,
      schemaEpoch: process.env.PROMOTION_SCHEMA_EPOCH,
      controlDigest: process.env.PROMOTION_CONTROL_DIGEST,
      gatewayDigest: process.env.PROMOTION_GATEWAY_DIGEST,
    });
    const handle = await open(args[0], "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }
  invariant(
    mode === "inspect-run" || mode === "validate",
    "mode must be create, inspect-run, or validate",
  );
  const evidenceOffset = mode === "validate" ? 1 : 0;
  invariant(
    args.length === 3 + evidenceOffset,
    `${mode} received an unexpected argument count`,
  );
  const expected = cliExpected(mode === "validate");
  const evidence = await loadEvidence(
    args[evidenceOffset],
    args[evidenceOffset + 1],
    args[evidenceOffset + 2],
  );
  const inspected = validateRunEvidence(evidence, expected);
  if (mode === "inspect-run") {
    await writeOutputs({
      artifact_id: inspected.artifactId,
      artifact_name: inspected.artifactName,
      run_attempt: String(inspected.runAttempt),
    });
    return;
  }
  const candidate = await readPromotionDirectory(args[0]);
  validatePromotion(candidate, {
    ...expected,
    runAttempt: inspected.runAttempt,
  });
  await writeOutputs({
    control_digest: candidate.control_digest,
    gateway_digest: candidate.gateway_digest,
    schema_epoch: candidate.schema_epoch,
    reviewed_sha: candidate.head_sha,
    staging_run_id: candidate.run_id,
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "invalid staging promotion"}\n`,
    );
    process.exitCode = 1;
  }
}
