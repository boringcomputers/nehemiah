# Nehemiah internal dogfood plan

Status: execution template  
Primary workloads: Bezalel and Ruth agent workflows  
Environment: isolated Nehemiah staging organization/project

The goal is to make real agent work—not a bespoke demo—the last validation stage
before external private beta. The current supported cohort exercises offline
fixture upload, install/test, browser/desktop, preview, fork, cancellation, files,
and cleanup through the same public API/SDK contract customers receive. It records
network-, OCI-, and volume-dependent phases as unsupported instead of silently
substituting a dormant implementation.

## Rules of engagement

- Use the supported Nehemiah SDK/provider interface. Do not call a host-local API,
  expose a host address, share an internal token, or repair a run by SSHing into a guest.
- Use a dedicated staging organization and one project per workload/cohort. Keys
  are project-scoped, least privilege, stored in the approved credential store,
  and absent from repositories, fixtures, logs, prompts, and recordings.
- Use the exact signed built-in B.C template/runtime-cohort digest and record it
  with every run. Managed OCI imports remain unsupported. Environment declarations
  use `Nehemiahfile` without embedded secrets.
- Keep strict project quotas, spending caps, TTLs, and `network_policy.mode=off`.
  Dogfood cannot waive a P0 control or enable dormant managed egress.
- Run shadow metering only until the [metering gate](metering.md#shadow-mode-release-gate)
  is approved. Do not charge an internal or external account from unverified usage.
- Treat Bezalel/Ruth as consumers. Do not pull unrelated agent product features
  into Nehemiah to make a test pass.

## Prerequisites

- [ ] Staging is isolated from production accounts, database, buckets, network,
      credentials, Clerk/Stripe configuration, and preview domain.
- [ ] At least three staging-equivalent host slots or the documented reduced-fleet
      drill topology are healthy, current, and have isolation evidence.
- [ ] Tenant/auth/preview SSRF, restart reconciliation, host-loss, capacity, and
      database-outage tests pass for the candidate build.
- [ ] The B.C SDK `Machine` contract supports Nehemiah mode and returns typed
      `NotSupported` rather than silently changing local/self-hosted behavior.
- [ ] Bezalel's `Sandbox` provider uses B.C machine create, exec/PTY, files,
      preview, fork, and stop through that SDK contract; provider tests pass.
- [ ] Dashboards correlate request, task, organization, project, machine, lease,
      host, usage, and audit IDs without customer command/file/terminal content.
- [ ] The on-call engineer has current [machine-debug](runbooks/debug-machine.md),
      [host-loss](runbooks/host-loss.md), [capacity](runbooks/capacity-exhaustion.md),
      and [database](runbooks/database-outage.md) runbooks.

## Workload matrix

Every supported workflow has a clean-cache and warm-cache cohort where applicable. Record
headless/desktop size, built-in template digest, host class, commit, network policy,
TTL, and expected exit/readiness result before running it.

| Workflow        | What to do through the public contract                                                                                          | What it validates                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Clone           | Unsupported while managed networking is off; record the phase as skipped and upload an approved bounded fixture archive instead | honest product-boundary reporting                                             |
| Install         | Install only vendored/offline locked dependencies from the uploaded fixture with bounded output/time                            | disk/I/O/PID limits, cancellation, agent persistence                          |
| Test            | Run unit/type/lint/build commands and return byte-exact separate stdout/stderr plus exit status                                 | CPU/memory, long exec, error fidelity                                         |
| Preview         | Start the application, pass port readiness, mint a short-lived URL, fetch and upgrade where supported                           | readiness separation, gateway route, capability, wildcard origin, SSRF bounds |
| Fork            | Prepare once, fork one child, then run divergent changes/tests in parent and child                                              | snapshot consistency, stable IDs, tenant ownership, cleanup                   |
| Batch fork      | Fork an approved batch from a retained golden machine; require all ready or all cleanup                                         | transactional quota, concurrency, all-or-cleanup semantics                    |
| Desktop/browser | Launch desktop size, connect VNC/action stream, exercise a guest-local page, capture non-content timing                         | desktop readiness, long-lived gateway path, network-off boundary              |
| Files           | Upload/download byte-verified fixtures; record volume attach as unsupported                                                     | file bounds, path safety, honest durable-data boundary                        |
| Cancellation    | Cancel exec, disconnect PTY/preview, stop during startup, and retry the same idempotency key                                    | cancellation, timeout, no duplicate process/VM, reconciliation                |
| Expiry/cleanup  | Let a run reach TTL and explicitly stop another; inspect state after reaper window                                              | stop idempotency, orphan rate, capacity and usage finalization                |

Test only repositories and fixtures approved for staging. Do not use production
customer data, personal credentials, unrestricted browser profiles, or unreviewed
secrets in a machine.

## Execution stages

### 1. Contract baseline

Run the provider's smallest create → ready → exec → stop workflow repeatedly on one
known-good immutable template. Confirm errors, pagination, idempotency, request
timeouts, and `NotSupported` behavior match the generated OpenAPI/SDK contract.
Freeze the run definition before using results as a comparison baseline.

### 2. Representative agent tasks

Run upload → offline install → test → preview → fork → divergent test → cleanup on selected
Bezalel and Ruth tasks. Include successful, test-failing, setup-failing, and timed-out
tasks so error fidelity is measured. A task is not successful merely because the
agent reports success; verify the expected repository/test/preview artifact.

### 3. Concurrency and golden pools

Run the approved parallel task and batch-fork cohorts within fixed project quotas.
Measure individual child readiness and batch all-ready time. Inject one child
failure and prove all-or-cleanup, stable retries, and no leaked reservations.

### 4. Controlled failures

In staging, execute the documented drills while a synthetic dogfood task is at
create, exec, preview, and delete boundaries:

- restart `nehemiahd` without draining and verify sibling scopes reconnect;
- drain/unplug a host and verify new placement avoids it and current leases become
  honestly lost after the configured threshold;
- exhaust project and fleet capacity and verify typed 429/503 with no overcommit;
- pause database connectivity and verify no unaudited creation occurs; and
- expire/revoke an API key and preview capability during use.

Coordinate every failure injection. Never inject it into production or a machine
holding unapproved data.

### 5. Soak and shadow metering

Run the representative mix over the approved observation window. Compare raw
usage to host monotonic runtime/configuration and independently collected capacity
metrics. Rebuild daily summaries and shadow Stripe exports. Track lingering
machine, process, scope, socket, cgroup, tap, overlay, gateway
connection, reservation, audit, and usage state after each run.

## Run record

Create one structured record per task attempt. Use identifiers/measurements, not
customer content.

| Field       | Record                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Run         | Run/cohort ID, UTC start/end, workload definition version, Bezalel/Ruth commit                                |
| Platform    | Nehemiah/gateway/host/guest-agent builds, host class, region                                                  |
| Source      | Signed built-in template/runtime-cohort digest, cache state, headless/desktop size                            |
| Policy      | Project quota, TTL, port/readiness, and network-off policy version                                            |
| Correlation | Task, request/trace, public machine, lease, fork parent/child IDs                                             |
| Timings     | admission, VMM started, guest ready, first exec, preview/TTY/VNC setup, fork all-ready, stop/capacity release |
| Outcome     | expected/actual task artifact, structured failure class, retry count, customer/platform attribution           |
| Cleanup     | terminal state, orphan scan time/result, reservation/audit/usage finalization                                 |
| Usage       | raw vCPU/memory/storage/egress totals, host comparison, discrepancy/confidence, shadow cost/rate-card version |
| Follow-up   | incident/issue, severity, owner, regression test, fixed-in build                                              |

Do not record raw commands, output, repository files, screenshots, URLs containing
capabilities, Authorization headers, cookies, or secret environment values.

## Metric definitions

- **Create-to-ready latency:** accepted request to `running` with initial
  `ready=true`; also report VMM-start and guest-agent/readiness sub-intervals.
- **First-exec latency:** ready to first byte and complete structured result for a
  fixed no-op command, by cold/restore/fork cohort.
- **Task completion rate:** verified expected task artifact ÷ started representative
  tasks, reported with platform-, agent-, and fixture-attributed failure classes.
- **Create success:** use the exact [SLO denominator](slo.md#machine-create-success-details),
  not agent-reported success.
- **Orphan rate:** runs with any residual runtime resource after the approved
  cleanup/reconciliation window ÷ terminal runs. Also count each resource class.
- **Fork success:** children ready and correct ÷ requested children; batch success
  requires all ready or confirmed all-cleanup.
- **Preview/stream success:** authorized connection established to the correct
  current lease/port ÷ eligible attempts, with unexpected disconnects separate.
- **Meter discrepancy:** absolute raw-ledger quantity minus independently derived
  host quantity, divided by the host quantity, by dimension; zero-denominator
  cases are listed rather than divided.
- **Cost per completed task:** shadow rated resource/pass-through cost ÷ verified
  completed tasks. Also report cost of failed/cancelled tasks; do not hide it.

Publish sample size, min/max/median/p95/p99/standard deviation and timeouts rather
than an average alone. Segment by source/cache, size, host/build, and workflow.

## Exit gates for external private beta

- [ ] No cross-tenant access, guest escape, private/metadata reachability, secret
      leak, preview SSRF, or other unresolved P0/P1 security finding occurred.
- [ ] Every task attempt is traceable from request through lifecycle, host,
      gateway, audit, cleanup, and raw usage without collecting customer content.
- [ ] All terminal runs in the approved gate cohort have zero unexplained orphan
      runtime resources after the reconciliation window; injected failures included.
- [ ] Create and gateway cohorts meet the activated [SLOs](slo.md), and measured
      performance thresholds/benchmark regression gates are filled from Latitude data.
- [ ] Batch fork proves all-ready or all-cleanup under failure and quota pressure.
- [ ] Shadow usage meets the approved discrepancy/window gate and a sample usage
      line is explainable/rebuildable end to end.
- [ ] Host loss, database outage, capacity exhaustion, and daemon restart drills
      pass with current evidence and no unaudited create or duplicate charge/reservation.
- [ ] The highest-impact reliability failure classes are fixed or explicitly block
      beta; each fix has a regression test and verified build.
- [ ] SDK/provider setup, errors, cleanup semantics, status/support route, and known
      limitations are clear enough for a developer outside the Nehemiah team.

“Mostly worked,” a demo video, or an average latency alone does not pass a gate.
The dogfood owner signs the report, links immutable evidence, and names the exact
candidate build/environment covered.

## Failure handling

Stop a cohort immediately for a security/isolation signal, duplicate active lease,
unbounded resource growth, unredacted credential/content, or database bypass.
Quarantine the artifact/host as appropriate and use incident procedures.

For reliability failures, preserve IDs/timestamps and use the machine-debug
runbook. Retry only with the original idempotency key. Do not silently exclude a
failed/time-out sample; classify it and keep it in the cohort result. After a fix,
run the minimal regression, the affected representative workflow, then the full
gate cohort if denominators or shared components changed.
