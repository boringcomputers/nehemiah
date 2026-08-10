import { invariant, validateCommit, validateRepository } from "./lib.mjs";

export const REQUIRED_CI_WORKFLOW = Object.freeze({
  name: "CI",
  path: ".github/workflows/ci.yml",
  jobs: Object.freeze([
    Object.freeze({
      id: "go",
      name: "host + guest agents (test, vet, build)",
    }),
    Object.freeze({
      id: "workspace",
      name: "workspace (check, lint, test, build)",
    }),
    Object.freeze({
      id: "wire-contract",
      name: "generated wire contract (drift, type-check, compile)",
    }),
    Object.freeze({ id: "shell", name: "infra scripts (shellcheck)" }),
  ]),
});

function validatePagedEvidence(evidence, property, label) {
  invariant(
    evidence && typeof evidence === "object" && !Array.isArray(evidence),
    `${label} evidence must be an object`,
  );
  invariant(
    Number.isSafeInteger(evidence.total_count) && evidence.total_count >= 0,
    `${label} evidence has an invalid total_count`,
  );
  invariant(
    Array.isArray(evidence[property]),
    `${label} evidence is missing ${property}`,
  );
  invariant(
    evidence.total_count === evidence[property].length,
    `${label} evidence is incomplete or paginated`,
  );
  return evidence[property];
}

function validWorkflowRunPath(path, defaultBranch) {
  return (
    path === REQUIRED_CI_WORKFLOW.path ||
    path === `${REQUIRED_CI_WORKFLOW.path}@${defaultBranch}`
  );
}

// Select a completed, successful push run for the exact release commit only
// after GitHub proves the commit belongs to the repository's protected default
// branch. All API payloads are treated as untrusted evidence and checked again
// here rather than relying on shell filtering or a human-readable check name.
export function selectAuthorizedCIRun(
  { repository, workflow, branch, comparison, runs },
  { expectedRepository, expectedCommit },
) {
  validateRepository(expectedRepository);
  validateCommit(expectedCommit);
  invariant(
    repository?.full_name === expectedRepository,
    "repository evidence does not match the release repository",
  );
  const defaultBranch = repository?.default_branch;
  invariant(
    typeof defaultBranch === "string" && defaultBranch.length > 0,
    "repository evidence is missing its default branch",
  );
  invariant(
    workflow?.name === REQUIRED_CI_WORKFLOW.name &&
      workflow?.path === REQUIRED_CI_WORKFLOW.path &&
      workflow?.state === "active" &&
      Number.isSafeInteger(workflow?.id) &&
      workflow.id > 0,
    "required CI workflow is missing, inactive, or has unexpected identity",
  );
  invariant(
    branch?.name === defaultBranch,
    "branch evidence is not for the repository default branch",
  );
  invariant(
    branch?.protected === true,
    "repository default branch is not protected",
  );
  const defaultHead = validateCommit(branch?.commit?.sha);
  invariant(
    comparison?.base_commit?.sha === expectedCommit,
    "commit comparison is not based on the exact release commit",
  );
  invariant(
    comparison?.merge_base_commit?.sha === expectedCommit &&
      comparison?.behind_by === 0 &&
      (comparison?.status === "ahead" || comparison?.status === "identical"),
    "release commit is not on the protected default branch",
  );
  if (comparison.status === "identical") {
    invariant(
      defaultHead === expectedCommit,
      "identical comparison does not match the protected default-branch head",
    );
  }

  const workflowRuns = validatePagedEvidence(
    runs,
    "workflow_runs",
    "CI workflow runs",
  );
  for (const run of workflowRuns) {
    invariant(
      Number.isSafeInteger(run?.id) && run.id > 0,
      "CI workflow evidence contains an invalid run id",
    );
    invariant(
      run?.workflow_id === workflow.id &&
        run?.name === REQUIRED_CI_WORKFLOW.name &&
        validWorkflowRunPath(run?.path, defaultBranch),
      "CI workflow run has unexpected workflow identity",
    );
    invariant(
      run?.head_sha === expectedCommit &&
        run?.head_branch === defaultBranch &&
        run?.event === "push" &&
        run?.repository?.full_name === expectedRepository &&
        run?.head_repository?.full_name === expectedRepository,
      "CI workflow run is not a default-branch push for the exact release commit",
    );
    invariant(
      Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0,
      "CI workflow run has an invalid attempt",
    );
  }
  const successful = workflowRuns
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .sort(
      (left, right) =>
        left.run_attempt - right.run_attempt || left.id - right.id,
    );
  invariant(
    successful.length > 0,
    "exact release commit has no successful default-branch CI push run",
  );
  return { defaultBranch, defaultHead, run: successful.at(-1) };
}

export function validateAuthorizedCIJobs(
  jobsEvidence,
  { run, expectedCommit, defaultBranch },
) {
  validateCommit(expectedCommit);
  const jobs = validatePagedEvidence(jobsEvidence, "jobs", "CI workflow jobs");
  const byName = new Map();
  for (const job of jobs) {
    invariant(
      Number.isSafeInteger(job?.id) && job.id > 0,
      "CI workflow evidence contains an invalid job id",
    );
    invariant(
      job?.run_id === run.id &&
        job?.head_sha === expectedCommit &&
        job?.head_branch === defaultBranch &&
        job?.workflow_name === REQUIRED_CI_WORKFLOW.name,
      "CI job is not bound to the authorized exact-SHA workflow run",
    );
    invariant(
      typeof job?.name === "string" && !byName.has(job.name),
      "CI workflow contains a missing or duplicate job name",
    );
    byName.set(job.name, job);
  }
  const requiredNames = REQUIRED_CI_WORKFLOW.jobs
    .map(({ name }) => name)
    .sort();
  invariant(
    JSON.stringify([...byName.keys()].sort()) === JSON.stringify(requiredNames),
    "CI workflow did not execute the exact required job matrix",
  );
  for (const name of requiredNames) {
    const job = byName.get(name);
    invariant(
      job.status === "completed" && job.conclusion === "success",
      `required CI job did not succeed: ${name}`,
    );
  }
  return true;
}

export function parseWorkflowJobNames(workflow) {
  invariant(typeof workflow === "string", "workflow YAML must be text");
  const jobs = new Map();
  let inJobs = false;
  let current;
  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      inJobs = true;
      current = undefined;
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s#]/.test(line)) break;
    const job = line.match(/^  ([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (job) {
      current = job[1];
      invariant(!jobs.has(current), `duplicate workflow job id: ${current}`);
      jobs.set(current, undefined);
      continue;
    }
    const name = line.match(/^    name:\s*(.+?)\s*$/);
    if (current && name && jobs.get(current) === undefined) {
      jobs.set(current, name[1].replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
    }
  }
  return jobs;
}

function workflowJobBlock(workflow, jobID) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^  ${jobID}:\\s*(?:#.*)?$`).test(line),
  );
  invariant(start >= 0, `release workflow is missing job ${jobID}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^  [A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function workflowStepBlock(job, stepName) {
  const lines = job.split("\n");
  const marker = `      - name: ${stepName}`;
  const start = lines.findIndex((line) => line === marker);
  invariant(start >= 0, `release workflow is missing step ${stepName}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^      - name:\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Offline policy validation runs in both CI and the release workflow. Keeping
// the job-name matrix exact makes adding or removing a CI job a reviewed
// release-policy change rather than silently weakening old-tag authorization.
export function validateReleaseWorkflowPolicy(
  releaseWorkflow,
  ciWorkflow,
  authorizationScript,
) {
  const actualJobs = parseWorkflowJobNames(ciWorkflow);
  const expectedIDs = REQUIRED_CI_WORKFLOW.jobs.map(({ id }) => id).sort();
  invariant(
    JSON.stringify([...actualJobs.keys()].sort()) ===
      JSON.stringify(expectedIDs),
    "CI workflow jobs do not match the exact release-required matrix",
  );
  for (const { id, name } of REQUIRED_CI_WORKFLOW.jobs) {
    invariant(
      actualJobs.get(id) === name,
      `CI job ${id} does not match its release-required check name`,
    );
  }
  invariant(
    ciWorkflow.includes("push:\n    branches: [main]"),
    "CI must run on pushes to the configured default branch",
  );
  const ciWorkspaceJob = workflowJobBlock(ciWorkflow, "workspace");
  for (const required of [
    "Check release authorization and artifact policy",
    "node --test scripts/release/test/*.test.mjs",
    "node scripts/release/check.mjs",
    "prettier --check .github/workflows/ci.yml .github/workflows/release.yml",
  ]) {
    invariant(
      ciWorkspaceJob.includes(required),
      `required exact-SHA CI does not enforce release policy: ${required}`,
    );
  }
  invariant(
    typeof authorizationScript === "string",
    "release CI authorization script is unavailable",
  );
  for (const required of [
    "set -euo pipefail",
    "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml",
    "branches/${encoded_branch}",
    "compare/${GITHUB_SHA}...${default_head}",
    "head_sha=${GITHUB_SHA}&event=push&status=completed&per_page=100",
    'verify-ci.mjs" --phase select',
    "jobs?filter=latest&per_page=100",
    "--phase verify",
    'rev-parse HEAD)\" == "$GITHUB_SHA"',
  ]) {
    invariant(
      authorizationScript.includes(required),
      `release CI authorization script is missing: ${required}`,
    );
  }
  invariant(
    !authorizationScript.includes("|| true") &&
      !authorizationScript.includes("--paginate"),
    "release CI authorization must not suppress or truncate evidence errors",
  );

  const validateJob = workflowJobBlock(releaseWorkflow, "validate");
  invariant(
    validateJob.includes("actions: read") &&
      validateJob.includes("contents: read"),
    "release validation needs read-only Actions and contents evidence",
  );
  const authorizationStep = workflowStepBlock(
    validateJob,
    "Authorize protected default-branch CI for the exact tag commit",
  );
  for (const required of [
    "if: github.event_name == 'push'",
    "GH_TOKEN: ${{ github.token }}",
    "run: scripts/release/authorize-ci.sh",
  ]) {
    invariant(
      authorizationStep.includes(required),
      `release validation is missing exact-SHA CI policy: ${required}`,
    );
  }
  invariant(
    !authorizationStep.includes("continue-on-error"),
    "exact-SHA CI authorization must fail the validation job",
  );
  const buildJob = workflowJobBlock(releaseWorkflow, "build");
  const guestImagesJob = workflowJobBlock(releaseWorkflow, "guest-images");
  const attestJob = workflowJobBlock(releaseWorkflow, "attest");
  const releaseJob = workflowJobBlock(releaseWorkflow, "release");
  invariant(
    buildJob.includes("- validate") &&
      guestImagesJob.includes("needs: validate"),
    "every release build must depend on authorization",
  );
  invariant(
    attestJob.includes("- validate") &&
      attestJob.includes("- build") &&
      attestJob.includes("actions: read"),
    "attestation must depend on authorized deterministic builds",
  );
  const attestationAuthorization = workflowStepBlock(
    attestJob,
    "Reauthorize protected default-branch CI before attestation",
  );
  invariant(
    attestationAuthorization.includes("GH_TOKEN: ${{ github.token }}") &&
      attestationAuthorization.includes(
        "run: scripts/release/authorize-ci.sh",
      ) &&
      !attestationAuthorization.includes("continue-on-error"),
    "attestation job must reauthorize exact-SHA CI before signing",
  );
  invariant(
    releaseJob.includes("- validate") &&
      releaseJob.includes("- attest") &&
      releaseJob.includes("actions: read"),
    "publication must depend on authorization and attestation",
  );
  invariant(
    releaseJob.includes(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    ) && releaseJob.includes("environment: release"),
    "publication must remain limited to v* tags in the protected release environment",
  );
  const publicationAuthorization = workflowStepBlock(
    releaseJob,
    "Reauthorize protected default-branch CI before signing",
  );
  invariant(
    publicationAuthorization.includes("GH_TOKEN: ${{ github.token }}") &&
      publicationAuthorization.includes(
        "run: scripts/release/authorize-ci.sh",
      ) &&
      !publicationAuthorization.includes("continue-on-error"),
    "protected release job must reauthorize exact-SHA CI before signing",
  );
  invariant(
    releaseJob.includes("gh release create") &&
      !validateJob.includes("gh release create") &&
      !buildJob.includes("gh release create") &&
      !guestImagesJob.includes("gh release create") &&
      !attestJob.includes("gh release create"),
    "GitHub Release publication escaped the authorized release job",
  );
  return true;
}
