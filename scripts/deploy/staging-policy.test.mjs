import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  REQUIRED_CI_WORKFLOW,
  validateAuthorizedCIJobs,
} from "../release/ci-policy.mjs";
import {
  STAGING_CI_AUTHORIZATION_STEP,
  validateStagingCIBarrier,
} from "./staging-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflow = YAML.parse(
  await readFile(
    path.join(root, ".github/workflows/deploy-staging.yml"),
    "utf8",
  ),
);
const authorizationScript = await readFile(
  path.join(root, "scripts/release/authorize-ci.sh"),
  "utf8",
);

const authorizationStep = (candidate) =>
  candidate.jobs.build.steps.find(
    (step) => step.name === STAGING_CI_AUTHORIZATION_STEP,
  );

test("staging authorizes the exact protected-main CI matrix before building", () => {
  assert.equal(validateStagingCIBarrier(workflow, authorizationScript), true);
});

test("the staging CI verifier requires the exact successful four-job matrix", () => {
  const names = REQUIRED_CI_WORKFLOW.jobs.map(({ name }) => name);
  assert.deepEqual(names, [
    "host + guest agents (test, vet, build)",
    "workspace (check, lint, test, build)",
    "generated wire contract (drift, type-check, compile)",
    "infra scripts (shellcheck)",
  ]);
  const run = { id: 123 };
  const expectedCommit = "a".repeat(40);
  const jobs = {
    total_count: names.length,
    jobs: names.map((name, index) => ({
      id: 1_000 + index,
      run_id: run.id,
      head_sha: expectedCommit,
      head_branch: "main",
      workflow_name: "CI",
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  assert.equal(
    validateAuthorizedCIJobs(jobs, {
      run,
      expectedCommit,
      defaultBranch: "main",
    }),
    true,
  );
  jobs.jobs.pop();
  jobs.total_count -= 1;
  assert.throws(
    () =>
      validateAuthorizedCIJobs(jobs, {
        run,
        expectedCommit,
        defaultBranch: "main",
      }),
    /exact required job matrix/,
  );
});

test("staging rejects missing evidence access or a suppressible CI barrier", () => {
  const missingPermission = structuredClone(workflow);
  delete missingPermission.jobs.build.permissions.actions;
  assert.throws(
    () => validateStagingCIBarrier(missingPermission, authorizationScript),
    /evidence permissions/,
  );

  const wrongToken = structuredClone(workflow);
  authorizationStep(wrongToken).env.GH_TOKEN = "${{ secrets.GITHUB_TOKEN }}";
  assert.throws(
    () => validateStagingCIBarrier(wrongToken, authorizationScript),
    /conditional, suppressible, or incorrectly invoked/,
  );

  const suppressed = structuredClone(workflow);
  authorizationStep(suppressed)["continue-on-error"] = true;
  assert.throws(
    () => validateStagingCIBarrier(suppressed, authorizationScript),
    /conditional, suppressible, or incorrectly invoked/,
  );
});

test("staging rejects CI authorization moved behind image tooling", () => {
  const reordered = structuredClone(workflow);
  const steps = reordered.jobs.build.steps;
  const index = steps.findIndex(
    (step) => step.name === STAGING_CI_AUTHORIZATION_STEP,
  );
  const [authorization] = steps.splice(index, 1);
  steps.splice(4, 0, authorization);
  assert.throws(
    () => validateStagingCIBarrier(reordered, authorizationScript),
    /first build barriers/,
  );
});

test("staging rejects weakened exact-SHA CI evidence selection", () => {
  const weakened = authorizationScript.replace(
    "head_sha=${GITHUB_SHA}&event=push",
    "branch=main&event=push",
  );
  assert.throws(
    () => validateStagingCIBarrier(workflow, weakened),
    /implementation is missing/,
  );
});
