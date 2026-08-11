import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CI_WORKFLOW,
  selectAuthorizedCIRun,
  validateAuthorizedCIJobs,
  validateReleaseWorkflowPolicy,
} from "../ci-policy.mjs";

const REPOSITORY = "boringcomputers/nehemiah";
const COMMIT = "1".repeat(40);
const DEFAULT_HEAD = "2".repeat(40);
const WORKFLOW_ID = 101;
const RUN_ID = 202;

function authorizationFixture() {
  return {
    repository: { full_name: REPOSITORY, default_branch: "main" },
    workflow: {
      id: WORKFLOW_ID,
      name: REQUIRED_CI_WORKFLOW.name,
      path: REQUIRED_CI_WORKFLOW.path,
      state: "active",
    },
    branch: {
      name: "main",
      protected: true,
      commit: { sha: DEFAULT_HEAD },
    },
    comparison: {
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      base_commit: { sha: COMMIT },
      merge_base_commit: { sha: COMMIT },
    },
    runs: {
      total_count: 1,
      workflow_runs: [
        {
          id: RUN_ID,
          workflow_id: WORKFLOW_ID,
          run_attempt: 1,
          name: REQUIRED_CI_WORKFLOW.name,
          path: `${REQUIRED_CI_WORKFLOW.path}@main`,
          head_sha: COMMIT,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          repository: { full_name: REPOSITORY },
          head_repository: { full_name: REPOSITORY },
        },
      ],
    },
  };
}

function jobsFixture() {
  return {
    total_count: REQUIRED_CI_WORKFLOW.jobs.length,
    jobs: REQUIRED_CI_WORKFLOW.jobs.map(({ name }, index) => ({
      id: 1_000 + index,
      run_id: RUN_ID,
      head_sha: COMMIT,
      head_branch: "main",
      workflow_name: REQUIRED_CI_WORKFLOW.name,
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
}

function select(evidence = authorizationFixture()) {
  return selectAuthorizedCIRun(evidence, {
    expectedRepository: REPOSITORY,
    expectedCommit: COMMIT,
  });
}

test("protected default-branch exact-SHA CI evidence authorizes the complete matrix", () => {
  const authorization = select();
  assert.equal(authorization.defaultBranch, "main");
  assert.equal(authorization.run.id, RUN_ID);
  assert.equal(
    validateAuthorizedCIJobs(jobsFixture(), {
      run: authorization.run,
      expectedCommit: COMMIT,
      defaultBranch: authorization.defaultBranch,
    }),
    true,
  );
});

test("off-main and unprotected tag commits cannot authorize publication", () => {
  const offMain = authorizationFixture();
  offMain.comparison.status = "diverged";
  offMain.comparison.behind_by = 1;
  offMain.comparison.merge_base_commit.sha = "3".repeat(40);
  assert.throws(() => select(offMain), /not on the protected default branch/);

  const unprotected = authorizationFixture();
  unprotected.branch.protected = false;
  assert.throws(() => select(unprotected), /default branch is not protected/);
});

test("missing or failed exact-SHA default-branch CI cannot authorize publication", () => {
  const missing = authorizationFixture();
  missing.runs = { total_count: 0, workflow_runs: [] };
  assert.throws(
    () => select(missing),
    /no successful default-branch CI push run/,
  );

  const failed = authorizationFixture();
  failed.runs.workflow_runs[0].conclusion = "failure";
  assert.throws(
    () => select(failed),
    /no successful default-branch CI push run/,
  );

  const wrongSHA = authorizationFixture();
  wrongSHA.runs.workflow_runs[0].head_sha = "4".repeat(40);
  assert.throws(
    () => select(wrongSHA),
    /not a default-branch push for the exact release commit/,
  );
});

test("missing, skipped, or failed required CI and wire-contract jobs cannot publish", () => {
  const authorization = select();
  const validate = (jobs) =>
    validateAuthorizedCIJobs(jobs, {
      run: authorization.run,
      expectedCommit: COMMIT,
      defaultBranch: authorization.defaultBranch,
    });

  const missing = jobsFixture();
  missing.jobs = missing.jobs.filter(
    ({ name }) =>
      name !== "generated wire contract (drift, type-check, compile)",
  );
  missing.total_count = missing.jobs.length;
  assert.throws(() => validate(missing), /exact required job matrix/);

  for (const conclusion of ["failure", "skipped"]) {
    const unsuccessful = jobsFixture();
    unsuccessful.jobs.find(
      ({ name }) =>
        name === "generated wire contract (drift, type-check, compile)",
    ).conclusion = conclusion;
    assert.throws(
      () => validate(unsuccessful),
      /required CI job did not succeed/,
    );
  }
});

test("release and CI YAML retain an exact fail-closed authorization dependency", async () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const releaseWorkflow = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const ciWorkflow = await readFile(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const authorizationScript = await readFile(
    path.join(root, "scripts/release/authorize-ci.sh"),
    "utf8",
  );
  assert.equal(
    validateReleaseWorkflowPolicy(
      releaseWorkflow,
      ciWorkflow,
      authorizationScript,
    ),
    true,
  );
  assert.throws(
    () =>
      validateReleaseWorkflowPolicy(
        releaseWorkflow.replace(
          "Authorize protected default-branch CI for the exact tag commit",
          "Authorization removed",
        ),
        ciWorkflow,
        authorizationScript,
      ),
    /missing step Authorize protected default-branch CI/,
  );
  assert.throws(
    () =>
      validateReleaseWorkflowPolicy(
        releaseWorkflow.replace(
          "      - name: Authorize protected default-branch CI for the exact tag commit\n        if: github.event_name == 'push'",
          "      - name: Authorize protected default-branch CI for the exact tag commit\n        if: github.event_name == 'workflow_dispatch'",
        ),
        ciWorkflow,
        authorizationScript,
      ),
    /missing exact-SHA CI policy/,
  );
  assert.throws(
    () =>
      validateReleaseWorkflowPolicy(
        releaseWorkflow,
        ciWorkflow.replace("  wire-contract:", "  omitted-contract:"),
        authorizationScript,
      ),
    /jobs do not match the exact release-required matrix/,
  );
  assert.throws(
    () =>
      validateReleaseWorkflowPolicy(
        releaseWorkflow,
        ciWorkflow.replace(
          "node --test scripts/release/test/*.test.mjs",
          "echo release-policy-tests-removed",
        ),
        authorizationScript,
      ),
    /exact-SHA CI does not enforce release policy/,
  );
  assert.throws(
    () =>
      validateReleaseWorkflowPolicy(
        releaseWorkflow,
        ciWorkflow,
        authorizationScript.replace(
          "head_sha=${GITHUB_SHA}&event=push",
          "branch=main&event=push",
        ),
      ),
    /authorization script is missing/,
  );
});
