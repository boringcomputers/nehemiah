const invariant = (condition, message) => {
  if (!condition) throw new Error(`staging CI barrier policy: ${message}`);
};

const object = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const STAGING_CI_AUTHORIZATION_STEP =
  "Authorize protected default-branch CI for the exact staging SHA";

export const validateStagingCIBarrier = (workflow, authorizationScript) => {
  const build = workflow?.jobs?.build;
  invariant(object(build), "build job is missing");
  invariant(
    build.permissions?.actions === "read" &&
      build.permissions?.contents === "read",
    "build job lacks read-only CI evidence permissions",
  );
  const steps = build.steps;
  invariant(Array.isArray(steps), "build steps are missing");

  const sourceIndex = steps.findIndex(
    (step) => step.name === "Require an exact protected-main candidate",
  );
  const checkoutIndex = steps.findIndex(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  const authorizationSteps = steps.filter(
    (step) => step.name === STAGING_CI_AUTHORIZATION_STEP,
  );
  invariant(
    authorizationSteps.length === 1,
    "exactly one CI authorization step is required",
  );
  const authorization = authorizationSteps[0];
  const authorizationIndex = steps.indexOf(authorization);
  invariant(
    sourceIndex === 0 && checkoutIndex === 1 && authorizationIndex === 2,
    "source, checkout, and CI authorization must be the first build barriers",
  );
  invariant(
    steps[sourceIndex].run?.includes(
      'test "$SOURCE_EVENT" = workflow_dispatch',
    ) &&
      steps[sourceIndex].run?.includes(
        'test "$SOURCE_REF" = refs/heads/main',
      ) &&
      steps[sourceIndex].run?.includes('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]'),
    "protected-main source guard is incomplete",
  );
  invariant(
    steps[checkoutIndex].with?.["persist-credentials"] === false,
    "staging checkout must not persist credentials",
  );
  invariant(
    object(authorization.env) &&
      Object.keys(authorization.env).length === 1 &&
      authorization.env.GH_TOKEN === "${{ github.token }}" &&
      authorization.run === "scripts/release/authorize-ci.sh" &&
      authorization.if === undefined &&
      authorization["continue-on-error"] === undefined,
    "exact-SHA CI authorization is conditional, suppressible, or incorrectly invoked",
  );

  const firstBuildOrPush = steps.findIndex(
    (step) =>
      typeof step.uses === "string" &&
      /^(?:docker\/(?:setup-buildx-action|login-action|build-push-action)|sigstore\/cosign-installer)@/.test(
        step.uses,
      ),
  );
  invariant(
    firstBuildOrPush > authorizationIndex,
    "CI authorization must complete before any image build or registry action",
  );

  invariant(
    typeof authorizationScript === "string",
    "CI authorization implementation is unavailable",
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
    'rev-parse HEAD)" == "$GITHUB_SHA"',
  ]) {
    invariant(
      authorizationScript.includes(required),
      `CI authorization implementation is missing ${required}`,
    );
  }
  invariant(
    !authorizationScript.includes("|| true") &&
      !authorizationScript.includes("--paginate"),
    "CI evidence errors or pagination must not be suppressed",
  );
  return true;
};
