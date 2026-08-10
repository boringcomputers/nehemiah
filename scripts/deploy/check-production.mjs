#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
const workflow = await readFile(workflowPath, "utf8");
const validator = await readFile(
  path.join(root, "scripts/deploy/promotion.mjs"),
  "utf8",
);
const parsed = YAML.parse(workflow);

const migrations = (
  await readdir(path.join(root, "apps/nehemiah/src/db/migrations"))
)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const latestMigration = migrations.at(-1);

const invariant = (condition, message) => {
  if (!condition) throw new Error(`production promotion policy: ${message}`);
};
const requireText = (value, label = value) =>
  invariant(workflow.includes(value), `missing ${label}`);
const requireValidatorText = (value, label = value) =>
  invariant(validator.includes(value), `validator is missing ${label}`);
const requireBefore = (first, second) => {
  const firstIndex = workflow.indexOf(first);
  const secondIndex = workflow.indexOf(second);
  invariant(
    firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex,
    `${first} must precede ${second}`,
  );
};

invariant(
  /^on:\n  workflow_dispatch:\n/m.test(workflow),
  "workflow is not manual-only",
);
invariant(
  Object.keys(parsed.on ?? {}).join(",") === "workflow_dispatch",
  "workflow contains a non-manual trigger",
);
for (const forbiddenTrigger of [
  "pull_request:",
  "pull_request_target:",
  "push:",
  "schedule:",
  "workflow_run:",
]) {
  invariant(
    !workflow.includes(`\n  ${forbiddenTrigger}`),
    `forbidden ${forbiddenTrigger} trigger`,
  );
}
invariant(
  Object.keys(parsed.jobs ?? {}).length === 1,
  "all production operations must stay in one environment-governed job",
);
const promote = parsed.jobs?.promote;
invariant(
  promote?.environment === "production",
  "production environment is missing",
);
invariant(
  promote?.["runs-on"] === "ubuntu-latest",
  "production must use a GitHub-hosted runner",
);
invariant(
  Number.isInteger(promote?.["timeout-minutes"]) &&
    promote["timeout-minutes"] > 0 &&
    promote["timeout-minutes"] <= 120,
  "production job timeout is missing or unbounded",
);
invariant(
  promote.permissions?.actions === "read" &&
    promote.permissions?.contents === "read" &&
    promote.permissions?.packages === "read" &&
    promote.permissions?.attestations === "read",
  "job permissions are not the read-only promotion set",
);
invariant(
  !Object.values(promote.permissions).includes("write"),
  "production job must not receive write permissions",
);
const inputs = parsed.on?.workflow_dispatch?.inputs;
invariant(
  inputs &&
    Object.keys(inputs).sort().join(",") ===
      "reviewed_main_sha,staging_run_id" &&
    inputs.reviewed_main_sha.required === true &&
    inputs.staging_run_id.required === true,
  "manual inputs are not the exact reviewed SHA and staging run ID",
);

for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
  invariant(
    /@[0-9a-f]{40}$/.test(match[1]),
    `action ${match[1]} is not pinned to a full commit`,
  );
}
requireText("ref: refs/heads/main", "fixed protected-main checkout");
requireText("persist-credentials: false", "credential-free checkout");
requireText('test "$SOURCE_SHA" = "$REVIEWED_SHA"', "dispatch SHA binding");
requireText(
  'test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"',
  "checked-out policy SHA binding",
);
requireText("/actions/runs/${STAGING_RUN_ID}", "GitHub workflow-run lookup");
requireText("/branches/main", "protected-main API lookup");
requireText("artifacts?per_page=100", "bounded artifact inventory lookup");
requireText(
  "node scripts/deploy/promotion.mjs inspect-run",
  "pre-download staging-run validation",
);
requireText(
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "pinned authorized artifact download",
);
requireText(
  "artifact-ids: ${{ steps.staging_run.outputs.artifact_id }}",
  "exact authorized artifact-id download",
);
requireText("merge-multiple: true", "single bounded artifact extraction path");
requireText(
  "Verify staging promotion provenance before parsing it",
  "promotion provenance verification",
);
requireText(
  "node scripts/deploy/promotion.mjs validate",
  "strict promotion record validation",
);
requireText(
  `EXPECTED_SCHEMA_EPOCH: ${latestMigration}`,
  "latest schema promotion epoch",
);
requireText(
  "gh attestation verify",
  "artifact and image provenance verification",
);
requireText("cosign verify", "promoted image signature verification");
requireText(
  '--source-digest "$REVIEWED_SHA"',
  "reviewed source digest verification",
);
requireText(
  "--source-ref refs/heads/main",
  "protected-main provenance binding",
);
requireText(
  "--deny-self-hosted-runners",
  "trusted hosted-builder provenance policy",
);
requireText(
  "steps.promotion.outputs.control_digest",
  "promoted control digest",
);
requireText(
  "steps.promotion.outputs.gateway_digest",
  "promoted gateway digest",
);
invariant(
  !workflow.includes("needs.build"),
  "production must not rebuild images",
);
invariant(
  !/nehemiah-(?:control|gateway):[^\s}]+/.test(workflow),
  "production image selection must not use a mutable tag",
);

const secretReferences = new Set();
for (const match of workflow.matchAll(
  /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g,
)) {
  invariant(
    match[1].startsWith("PROD_"),
    `non-production secret ${match[1]} is referenced`,
  );
  secretReferences.add(match[1]);
}
invariant(
  [...secretReferences].sort().join(",") ===
    [
      "PROD_DATABASE_URL",
      "PROD_DEPLOY_TOKEN",
      "PROD_DEPLOY_WEBHOOK",
      "PROD_MIGRATION_DATABASE_URL",
      "PROD_SMOKE_API_KEY",
    ].join(","),
  "production secret allowlist does not match",
);
const variableReferences = new Set();
for (const match of workflow.matchAll(
  /\$\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g,
)) {
  invariant(
    match[1].startsWith("PROD_"),
    `non-production variable ${match[1]} is referenced`,
  );
  variableReferences.add(match[1]);
}
invariant(
  [...variableReferences].sort().join(",") ===
    ["PROD_API_URL", "PROD_HEALTH_URL", "PROD_SMOKE_PROJECT_ID"].join(","),
  "production variable allowlist does not match",
);
invariant(!/secrets\s*\[/.test(workflow), "dynamic secret lookup is forbidden");
invariant(!/vars\s*\[/.test(workflow), "dynamic variable lookup is forbidden");
invariant(
  !workflow.includes("secrets.STAGING_") && !workflow.includes("vars.STAGING_"),
  "staging environment configuration leaked into production",
);

requireBefore(
  "Authorize the exact completed staging run",
  "Download only the authorized staging promotion artifact",
);
requireBefore(
  "Download only the authorized staging promotion artifact",
  "Verify staging promotion provenance before parsing it",
);
requireBefore(
  "Verify staging promotion provenance before parsing it",
  "Validate the exact promotion record and schema epoch",
);
requireBefore(
  "Validate the exact promotion record and schema epoch",
  "Verify promoted image signatures and provenance before cutover",
);
requireBefore(
  "Verify promoted image signatures and provenance before cutover",
  "Drain and fence every prior production schema/protocol revision",
);
requireBefore(
  "Drain and fence every prior production schema/protocol revision",
  "Run the one-shot production migration from the promoted control image",
);
requireBefore(
  "Run the one-shot production migration from the promoted control image",
  "Request the exact digest-pinned production deployment",
);
requireBefore(
  "Request the exact digest-pinned production deployment",
  "Production health gate",
);
requireBefore(
  "Production health gate",
  "Live production machine lifecycle smoke gate",
);
requireText('"${HEALTH_URL%/}/readyz"', "production readiness endpoint");
requireText(
  "for template in python desktop",
  "headless and desktop production smoke matrix",
);
requireText(
  "npm run test:nehemiah:smoke",
  "supported production lifecycle smoke harness",
);
requireText(
  "prepare_maintenance_cutover",
  "stop-the-world maintenance preparation",
);
requireText("commit_maintenance_cutover", "digest-bound deployment commit");
requireText(
  'node scripts/deploy/cutover-response.mjs prepare "$response"',
  "strict maintenance acknowledgement",
);
requireText(
  'node scripts/deploy/cutover-response.mjs commit "$response"',
  "strict deployment acknowledgement",
);
requireText(
  "PROD_MIGRATION_DATABASE_URL",
  "owner-only production migration role",
);
requireText(
  '"$CONTROL_IMAGE" dist/db/migrate.js',
  "promoted-image migration command",
);
requireText(
  "if: ${{ (failure() || cancelled()) && steps.cutover.outputs.cutover_id != '' }}",
  "maintenance hold after any acknowledged cutover failure",
);
requireText("hold_maintenance", "fail-closed maintenance hold");
invariant(
  !/action\\?"?:\\?"?rollback/.test(workflow),
  "an automatic rollback may not revive a schema-incompatible revision",
);
const steps = promote.steps;
invariant(
  Array.isArray(steps) && steps.length > 0,
  "promotion steps are missing",
);
invariant(
  steps.at(-1)?.name === "Keep production fenced after any failed cutover gate",
  "maintenance hold must remain the final production step",
);

requireValidatorText(
  "run.path === STAGING_WORKFLOW_PATH",
  "exact staging workflow path check",
);
requireValidatorText(
  "run.event === STAGING_EVENT",
  "manual staging event check",
);
requireValidatorText('run.status === "completed"', "completed run check");
requireValidatorText('run.conclusion === "success"', "successful run check");
requireValidatorText("branch.protected === true", "protected-main check");
requireValidatorText(
  "promotion record has an unexpected shape",
  "exact promotion record shape check",
);
requireValidatorText(
  "MAX_PROMOTION_BYTES = 4_096",
  "4 KiB promotion record bound",
);
requireValidatorText(
  "MAX_PROMOTION_AGE_MS = 24 * 60 * 60 * 1_000",
  "24-hour successful-staging evidence bound",
);
requireValidatorText(
  "successful staging evidence is older than 24 hours",
  "stale promotion rejection",
);

process.stdout.write("production staging-promotion policy is valid\n");
