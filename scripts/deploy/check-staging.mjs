#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateStagingCIBarrier } from "./staging-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(root, ".github/workflows/deploy-staging.yml");
const workflow = await readFile(workflowPath, "utf8");
const controlDockerfile = await readFile(
  path.join(root, "deploy/nehemiah/Dockerfile"),
  "utf8",
);
const gatewayDockerfile = await readFile(
  path.join(root, "deploy/gateway/Dockerfile"),
  "utf8",
);
const ciAuthorization = await readFile(
  path.join(root, "scripts/release/authorize-ci.sh"),
  "utf8",
);
const parsedWorkflow = YAML.parse(workflow);
validateStagingCIBarrier(parsedWorkflow, ciAuthorization);

const migrations = (
  await readdir(path.join(root, "apps/nehemiah/src/db/migrations"))
)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const latestMigration = migrations.at(-1);

const invariant = (condition, message) => {
  if (!condition) throw new Error(`staging deployment policy: ${message}`);
};
const requireText = (value, label = value) =>
  invariant(workflow.includes(value), `missing ${label}`);
const requireBefore = (first, second) => {
  const firstIndex = workflow.indexOf(first);
  const secondIndex = workflow.indexOf(second);
  invariant(
    firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex,
    `${first} must precede ${second}`,
  );
};

invariant(
  Object.keys(parsedWorkflow.on ?? {}).join(",") === "workflow_dispatch",
  "staging deployment must be manual-only",
);
for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
  const reference = match[1];
  invariant(
    /@[0-9a-f]{40}$/.test(reference),
    `action ${reference} is not pinned to a full commit`,
  );
}
requireText("provenance: mode=max", "maximal BuildKit provenance");
requireText("sbom: true", "BuildKit SBOM generation");
requireText(
  "scripts/release/guest-images/prepare-vulnerability-scanner.sh",
  "checksum-pinned vulnerability scanner",
);
requireText(
  "--severity HIGH,CRITICAL --exit-code 1",
  "blocking HIGH/CRITICAL scan",
);
invariant(
  !workflow.includes("--ignore-unfixed"),
  "vulnerability scan must not ignore unfixed findings",
);
requireText("cosign sign --yes", "keyless digest signature");
requireText("push-to-registry: true", "registry provenance attachment");
requireText("gh attestation verify", "source-bound provenance verification");
requireText('--source-digest "$GITHUB_SHA"', "source commit verification");
requireText("--deny-self-hosted-runners", "hosted trusted-builder policy");
requireText(
  'test "$SOURCE_REF" = refs/heads/main',
  "protected-main staging source guard",
);
requireText("persist-credentials: false", "credential-free source checkout");
requireText(
  "scripts/release/authorize-ci.sh",
  "exact-SHA protected default-branch CI authorization",
);
requireBefore(
  "Authorize protected default-branch CI for the exact staging SHA",
  "docker/setup-buildx-action",
);
requireBefore(
  "Verify signatures and provenance before deployment",
  "Drain and fence every prior schema/protocol revision",
);
requireBefore(
  "Drain and fence every prior schema/protocol revision",
  "Run the one-shot migration from the verified control image",
);
requireBefore(
  "Run the one-shot migration from the verified control image",
  "Request digest-pinned staging deployment",
);
requireText(
  "STAGING_MIGRATION_DATABASE_URL",
  "owner-only staging migration secret",
);
requireText(
  '"$CONTROL_IMAGE" dist/db/migrate.js',
  "verified-image migration command",
);
requireText("prepare_maintenance_cutover", "maintenance cutover preparation");
requireText(`SCHEMA_EPOCH: ${latestMigration}`, "latest schema cutover epoch");
requireText(
  'node scripts/deploy/cutover-response.mjs prepare "$response"',
  "strict cutover acknowledgement validation",
);
requireText("commit_maintenance_cutover", "maintenance cutover commit");
requireText(
  'node scripts/deploy/cutover-response.mjs commit "$response"',
  "strict deployed acknowledgement validation",
);
requireText("hold_maintenance", "fail-closed post-cutover recovery");
invariant(
  !/action\\?"?:\\?"?rollback/.test(workflow),
  "an automatic rollback may not revive a schema-incompatible revision",
);
requireBefore(
  "Scan the exact published image digests",
  "Sign the exact published image digests",
);
requireText(
  '[[ "$CONTROL_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
  "control digest validation",
);
requireText(
  '[[ "$GATEWAY_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
  "gateway digest validation",
);
requireText(
  "node scripts/deploy/promotion.mjs create",
  "strict promotion record creation",
);
requireText(
  `PROMOTION_SCHEMA_EPOCH: ${latestMigration}`,
  "latest promotion schema epoch",
);
requireText(
  "subject-path: ${{ runner.temp }}/staging-promotion/promotion.json",
  "promotion provenance attestation",
);
requireText(
  "name: staging-promotion-${{ github.run_id }}-${{ github.run_attempt }}",
  "run-scoped promotion artifact",
);
requireText("compression-level: 0", "bounded uncompressed promotion artifact");
requireBefore(
  "Live REST and WebSocket load gate",
  "Create the exact successful-staging promotion record",
);
requireBefore(
  "Create the exact successful-staging promotion record",
  "Attest the exact successful-staging promotion record",
);
requireBefore(
  "Attest the exact successful-staging promotion record",
  "Retain the bounded successful-staging promotion record",
);
const deploySteps = parsedWorkflow.jobs?.deploy?.steps;
invariant(Array.isArray(deploySteps), "deploy steps are missing");
const promotionUpload = deploySteps.find(
  (step) =>
    step.name === "Retain the bounded successful-staging promotion record",
);
invariant(objectLike(promotionUpload), "promotion upload step is missing");
invariant(
  deploySteps.indexOf(promotionUpload) === deploySteps.length - 2 &&
    deploySteps.at(-1)?.name ===
      "Keep staging fenced after a failed cutover gate",
  "promotion upload must follow every normal gate and precede only the failure handler",
);
invariant(
  promotionUpload.if === undefined,
  "promotion artifact must be emitted only on default step success",
);
invariant(
  deploySteps.at(-1)?.if ===
    "${{ (failure() || cancelled()) && steps.cutover.outputs.cutover_id != '' }}",
  "failed or cancelled acknowledged cutovers must remain fenced",
);
invariant(
  parsedWorkflow.jobs.deploy.permissions?.["id-token"] === "write" &&
    parsedWorkflow.jobs.deploy.permissions?.attestations === "write" &&
    parsedWorkflow.jobs.deploy.permissions?.["artifact-metadata"] === "write",
  "promotion attestation permissions are incomplete",
);
for (const [name, dockerfile] of [
  ["control", controlDockerfile],
  ["gateway", gatewayDockerfile],
]) {
  for (const instruction of dockerfile.matchAll(/^FROM\s+([^\s]+).*$/gm)) {
    invariant(
      /@sha256:[0-9a-f]{64}$/.test(instruction[1]),
      `${name} image base is not digest-pinned`,
    );
  }
}
invariant(
  controlDockerfile.includes(
    "npm prune --omit=dev --workspace @nehemiah/nehemiah --include-workspace-root",
  ),
  "control image does not prune development dependencies",
);
invariant(
  /^USER node$/m.test(controlDockerfile),
  "control image does not run as node",
);
invariant(
  /distroless\/static-debian12:nonroot@sha256:[0-9a-f]{64}/.test(
    gatewayDockerfile,
  ),
  "gateway runtime is not the pinned non-root distroless image",
);

process.stdout.write(
  "staging image scan/sign/provenance and promotion policy is valid\n",
);

function objectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
