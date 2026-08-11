#!/usr/bin/env bash
# Fail-closed GitHub release authorization. This is run both before release
# builds and again inside the protected release environment before signing.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "release repository is unsafe" >&2
  exit 1
}
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40,64}$ ]] || {
  echo "release commit is not a full Git object id" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/../.." && pwd -P)"
evidence_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$evidence_dir"
}
trap cleanup EXIT
api_version="X-GitHub-Api-Version: 2022-11-28"

gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}" > "$evidence_dir/repository.json"
gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml" \
  > "$evidence_dir/workflow.json"
default_branch="$(jq -er '.default_branch | select(type == "string" and length > 0)' "$evidence_dir/repository.json")"
encoded_branch="$(jq -nr --arg value "$default_branch" '$value | @uri')"
gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}/branches/${encoded_branch}" \
  > "$evidence_dir/branch.json"
default_head="$(jq -er '.commit.sha | select(test("^[0-9a-f]{40,64}$"))' "$evidence_dir/branch.json")"
gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}/compare/${GITHUB_SHA}...${default_head}" \
  > "$evidence_dir/comparison.json"
gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}&event=push&status=completed&per_page=100" \
  > "$evidence_dir/runs.json"

verify_args=(
  --repository "$GITHUB_REPOSITORY"
  --commit "$GITHUB_SHA"
  --repository-evidence "$evidence_dir/repository.json"
  --workflow-evidence "$evidence_dir/workflow.json"
  --branch-evidence "$evidence_dir/branch.json"
  --comparison-evidence "$evidence_dir/comparison.json"
  --runs-evidence "$evidence_dir/runs.json"
)
run_id="$(node "$script_dir/verify-ci.mjs" --phase select "${verify_args[@]}")"
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || {
  echo "release CI verifier returned an unsafe run id" >&2
  exit 1
}
gh api -H "$api_version" \
  "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?filter=latest&per_page=100" \
  > "$evidence_dir/jobs.json"
node "$script_dir/verify-ci.mjs" \
  --phase verify \
  "${verify_args[@]}" \
  --jobs-evidence "$evidence_dir/jobs.json"

# Keep this check last: it catches an unexpected invocation from outside the
# checked-out repository after all evidence paths have remained private.
[[ "$(git -C "$repository_root" rev-parse HEAD)" == "$GITHUB_SHA" ]] || {
  echo "checked-out release commit changed during authorization" >&2
  exit 1
}
