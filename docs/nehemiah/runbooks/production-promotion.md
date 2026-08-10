# Production promotion

Status: operator runbook for manual private-beta promotion

Production is promoted from evidence produced by the manual
`Deploy staging` workflow. The production workflow does not rebuild an image and
does not accept an image tag or digest from an operator. Its only inputs are a
successful staging workflow run ID and the exact reviewed `main` commit SHA.

## One-time GitHub configuration

Protect `main` and configure the `production` GitHub environment before enabling
the workflow. The environment must:

- allow deployments only from `main`;
- require the designated production reviewers and prevent self-review;
- keep environment administrators from bypassing the protection rules; and
- contain only the production credentials and variables listed below.

The repository and environment controls are external configuration. The static
repository checks cannot prove they are enabled; retain screenshots or API
evidence of the effective rules with each release-readiness review.

Required environment secrets:

- `PROD_DEPLOY_WEBHOOK`: HTTPS maintenance/cutover controller endpoint;
- `PROD_DEPLOY_TOKEN`: least-privilege controller bearer credential;
- `PROD_DATABASE_URL`: runtime database role used by the one-shot image;
- `PROD_MIGRATION_DATABASE_URL`: distinct owner-only migration role; and
- `PROD_SMOKE_API_KEY`: isolated production-smoke project credential.

Required environment variables:

- `PROD_HEALTH_URL`: public production health origin;
- `PROD_API_URL`: public production API origin; and
- `PROD_SMOKE_PROJECT_ID`: disposable, quota-bounded production-smoke project.

The controller must implement the strict response contract checked by
`scripts/deploy/cutover-response.mjs`. It must keep old control-plane writers
fenced and every old control/gateway replica stopped throughout migration. A
failed or interrupted request must stay in maintenance until an operator performs
a reviewed forward repair.

## What staging makes promotable

The staging workflow accepts only a manual run at `refs/heads/main`. It builds,
scans, signs, and attests the exact control and gateway digests only after the
existing CI workflow has a completed successful default-branch push run for the
same SHA and its exact host/guest, workspace, wire-contract, and shell job matrix
all passed. It then performs the maintenance cutover and runs every staging
health, lifecycle, tenant-isolation, host-loss, billing-reconciliation, and load
gate.

Only after those gates pass does it create canonical `promotion.json`, attest that
file with GitHub OIDC provenance, and upload the single-file artifact named
`staging-promotion-<run-id>-<run-attempt>`. The record is at most 4 KiB and binds:

- schema version, repository, staging workflow path, event, run ID and attempt;
- protected branch/ref and exact 40-character head SHA;
- the exact latest database schema migration filename; and
- distinct SHA-256 control and gateway image digests.

The artifact is retained for 30 days. Its presence alone is not authorization:
production also requires the associated GitHub run to be completed successfully
within the prior 24 hours and the reviewed SHA to remain current protected
`main`. The longer retention supports incident evidence, not delayed promotion.

## Promote

1. Review the exact staging run within 24 hours of its start/completion. Confirm
   all jobs and live gates passed and record its numeric run ID and 40-character
   lowercase head SHA.
2. Confirm the reviewed SHA is still the tip of protected `main`. If `main`
   advanced, run staging again for the new candidate; do not promote the older
   artifact.
3. Manually dispatch `Promote staging to production` from `main`, entering only
   `staging_run_id` and `reviewed_main_sha`.
4. The required production reviewer compares the run, commit, incident/change
   record, and staging evidence before approving the environment deployment.
5. Observe the workflow through production health and both `python` and `desktop`
   lifecycle smoke gates. Do not cancel a run after maintenance preparation unless
   the controller is independently confirmed to remain fenced.

Before any cutover request, the workflow fail-closed checks all of the following:

- invocation ref, checked-out policy, protected-main API state, staging run ID,
  workflow path, event, head repository/SHA, run attempt, status, conclusion, and
  bounded non-future creation/completion timestamps;
- exactly one non-expired, bounded, run-linked promotion artifact;
- promotion artifact provenance and exact canonical record shape/schema epoch;
- keyless signatures and hosted-builder provenance for both promoted image
  digests, bound to the reviewed staging workflow and source SHA; and
- production-only environment references and a distinct migration credential.

It then prepares maintenance, verifies zero prior replicas/streams and fenced
database writers, migrates with the promoted control image, commits the exact two
digests, checks readiness, and runs the production lifecycle smoke project.

## Failure and recovery

There is no automatic rollback. Once migration starts, an older image may be
schema-incompatible. Any failure after an acknowledged maintenance preparation
causes a final `hold_maintenance` request; a prepare response lost or rejected by
the client is already required to remain in controller maintenance.

On failure:

1. Confirm the controller reports maintenance, zero old replicas/streams, and
   fenced old writers. If that cannot be proven, treat it as an incident.
2. Preserve the workflow run, promotion artifact/attestation, cutover ID, exact
   digests, schema epoch, and controller response without copying credentials.
3. Diagnose using the database and deployment-controller runbooks. Repair
   forward from the promoted schema and reviewed images.
4. Resume service only through a reviewed controller action that revalidates the
   exact schema and digests. Never revive an older schema/protocol revision.

Repository unit/static tests prove the record/parser and workflow policy against
synthetic evidence. They do not prove GitHub branch/environment protection, OIDC,
registry attestations, controller fencing, production database roles, or live
smoke behavior; those remain external promotion evidence.
