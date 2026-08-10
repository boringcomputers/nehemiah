import assert from "node:assert/strict";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPromotion,
  MAX_PROMOTION_BYTES,
  PROMOTION_FILE,
  promotionArtifactName,
  readPromotionDirectory,
  validatePromotion,
  validateRunEvidence,
} from "./promotion.mjs";

const repository = "boring-computers/boring-computers";
const runId = "123456789";
const runAttempt = 2;
const headSha = "a".repeat(40);
const schemaEpoch = "0035_project_allocation_bounds.sql";
const controlDigest = `sha256:${"b".repeat(64)}`;
const gatewayDigest = `sha256:${"c".repeat(64)}`;
const artifactId = 987654321;
const apiUrl = "https://api.github.com";
const nowMs = Date.parse("2026-08-09T12:00:00Z");

const expected = {
  repository,
  runId,
  headSha,
  schemaEpoch,
  controlDigest,
  gatewayDigest,
  apiUrl,
  nowMs,
};

const promotion = () =>
  createPromotion({
    repository,
    runId,
    runAttempt,
    headSha,
    schemaEpoch,
    controlDigest,
    gatewayDigest,
  });

const evidence = () => ({
  run: {
    id: Number(runId),
    path: ".github/workflows/deploy-staging.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-09T10:00:00Z",
    updated_at: "2026-08-09T11:30:00Z",
    run_attempt: runAttempt,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  },
  branch: {
    name: "main",
    protected: true,
    commit: { sha: headSha },
  },
  artifactListing: {
    total_count: 2,
    artifacts: [
      {
        id: 123,
        name: `staging-service-image-scans-${headSha}`,
        expired: false,
        size_in_bytes: 2_048,
      },
      {
        id: artifactId,
        name: promotionArtifactName(runId, runAttempt),
        expired: false,
        size_in_bytes: 1_024,
        digest: `sha256:${"d".repeat(64)}`,
        archive_download_url: `${apiUrl}/repos/${repository}/actions/artifacts/${artifactId}/zip`,
        workflow_run: {
          id: Number(runId),
          head_branch: "main",
          head_sha: headSha,
        },
      },
    ],
  },
});

test("creates one canonical, run-bound promotion record", () => {
  const candidate = promotion();
  assert.deepEqual(Object.keys(candidate), [
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
  ]);
  assert.equal(candidate.run_id, runId);
  assert.equal(candidate.schema_epoch, schemaEpoch);
  assert.equal(
    validatePromotion(candidate, { ...expected, runAttempt }),
    candidate,
  );
});

test("accepts only a successful staging dispatch for current protected main", () => {
  const candidate = evidence();
  assert.deepEqual(validateRunEvidence(candidate, expected), {
    artifactId: String(artifactId),
    artifactName: promotionArtifactName(runId, runAttempt),
    runAttempt,
  });

  const mutations = [
    (value) => (value.run.id += 1),
    (value) => (value.run.path = ".github/workflows/ci.yml"),
    (value) => (value.run.event = "push"),
    (value) => (value.run.head_branch = "release"),
    (value) => (value.run.head_sha = "e".repeat(40)),
    (value) => (value.run.status = "in_progress"),
    (value) => (value.run.conclusion = "failure"),
    (value) => (value.run.repository.full_name = "other/repo"),
    (value) => (value.run.head_repository.full_name = "fork/repo"),
    (value) => {
      value.run.created_at = "2026-08-08T10:00:00Z";
      value.run.updated_at = "2026-08-08T11:00:00Z";
    },
    (value) => {
      value.run.created_at = "2026-08-09T12:10:00Z";
      value.run.updated_at = "2026-08-09T12:11:00Z";
    },
    (value) => {
      value.run.created_at = "2026-08-09T11:30:00Z";
      value.run.updated_at = "2026-08-09T11:00:00Z";
    },
    (value) => (value.branch.protected = false),
    (value) => (value.branch.commit.sha = "f".repeat(40)),
  ];
  for (const mutate of mutations) {
    const invalid = evidence();
    mutate(invalid);
    assert.throws(() => validateRunEvidence(invalid, expected));
  }
});

test("rejects ambiguous, expired, oversized, or rebound promotion artifacts", () => {
  const mutations = [
    (value) =>
      value.artifactListing.artifacts.push({
        ...value.artifactListing.artifacts[1],
        id: artifactId + 1,
      }),
    (value) =>
      (value.artifactListing.artifacts[1].name = "staging-promotion-1-1"),
    (value) => (value.artifactListing.artifacts[1].expired = true),
    (value) => (value.artifactListing.artifacts[1].size_in_bytes = 16_385),
    (value) => (value.artifactListing.artifacts[1].workflow_run.id += 1),
    (value) =>
      (value.artifactListing.artifacts[1].workflow_run.head_sha = "f".repeat(
        40,
      )),
    (value) =>
      (value.artifactListing.artifacts[1].archive_download_url +=
        "?redirect=1"),
    (value) =>
      (value.artifactListing.artifacts[1].digest = "sha256:not-a-digest"),
  ];
  for (const mutate of mutations) {
    const invalid = evidence();
    mutate(invalid);
    invalid.artifactListing.total_count =
      invalid.artifactListing.artifacts.length;
    assert.throws(() => validateRunEvidence(invalid, expected));
  }
});

test("rejects replay, substitutions, schema drift, and extra record fields", () => {
  const mutations = [
    (value) => (value.run_id = "123456788"),
    (value) => (value.run_attempt = 1),
    (value) => (value.head_sha = "f".repeat(40)),
    (value) => (value.schema_epoch = "0032_api_key_allocation_bounds.sql"),
    (value) => (value.control_digest = `sha256:${"e".repeat(64)}`),
    (value) => (value.gateway_digest = value.control_digest),
    (value) => (value.unreviewed = true),
  ];
  for (const mutate of mutations) {
    const invalid = promotion();
    mutate(invalid);
    assert.throws(() =>
      validatePromotion(invalid, { ...expected, runAttempt }),
    );
  }
});

test("reads only a single small regular canonical promotion.json", async (t) => {
  const roots = [];
  t.after(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });
  const makeRoot = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "promotion-test-"));
    roots.push(root);
    return root;
  };
  const canonical = `${JSON.stringify(promotion(), null, 2)}\n`;

  const valid = await makeRoot();
  await writeFile(path.join(valid, PROMOTION_FILE), canonical, { mode: 0o600 });
  assert.deepEqual(await readPromotionDirectory(valid), promotion());

  const extra = await makeRoot();
  await writeFile(path.join(extra, PROMOTION_FILE), canonical);
  await writeFile(path.join(extra, "note.txt"), "unexpected");
  await assert.rejects(readPromotionDirectory(extra));

  const symlinkTarget = await makeRoot();
  const symlinkArtifact = await makeRoot();
  const target = path.join(symlinkTarget, "target.json");
  await writeFile(target, canonical);
  await symlink(target, path.join(symlinkArtifact, PROMOTION_FILE));
  await assert.rejects(readPromotionDirectory(symlinkArtifact));

  const hardlinkTarget = await makeRoot();
  const hardlinkArtifact = await makeRoot();
  const targetFile = path.join(hardlinkTarget, "target.json");
  await writeFile(targetFile, canonical);
  await link(targetFile, path.join(hardlinkArtifact, PROMOTION_FILE));
  await assert.rejects(readPromotionDirectory(hardlinkArtifact));

  const oversized = await makeRoot();
  await writeFile(
    path.join(oversized, PROMOTION_FILE),
    "x".repeat(MAX_PROMOTION_BYTES + 1),
  );
  await assert.rejects(readPromotionDirectory(oversized));

  const nonCanonical = await makeRoot();
  await writeFile(
    path.join(nonCanonical, PROMOTION_FILE),
    JSON.stringify(promotion()),
  );
  await assert.rejects(readPromotionDirectory(nonCanonical));
});
