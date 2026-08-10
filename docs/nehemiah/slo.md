# Nehemiah private-beta SLOs

Status: proposed launch reliability objectives; performance thresholds await staging baselines  
Last updated: 2026-08-09  
Initial scope: one production region, supported B.C templates, headless and desktop sizes

These objectives define what Nehemiah measures and how error budget decisions are
made. They are engineering reliability targets, not a contractual SLA. Cloudflare,
Clerk, PostgreSQL, object storage, Latitude, and network failures count whenever
they make the customer operation fail; dependency ownership is not an exclusion.

## Launch SLOs

| User journey                    | Service-level indicator                                                                                                                    | Proposed target        | Window                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------ |
| Control API availability        | Valid, authenticated, in-scope requests returning the documented non-5xx response ÷ all eligible requests                                  | 99.9%                  | Rolling 30 days                      |
| Admitted machine-create success | Admitted creates whose lease persists `running` with `ready=true` for the same lease generation ÷ admitted creates (customer-attributable terminal outcomes are reported separately, not counted as success) | 99.0% platform success | Rolling 30 days, also reported daily |
| Gateway connection availability | Authorized REST stream/TTY/VNC/preview connection attempts established to the current ready lease ÷ eligible attempts                      | 99.9%                  | Rolling 30 days                      |

These targets activate only after at least two representative staging weeks have
validated instrumentation and denominators. If measured beta hardware cannot
support them, change this document through review before inviting customers; do
not silently redefine success or exclude failures after seeing results.

### API availability details

Eligible requests have valid syntax/authentication, reference a supported feature,
and are within a documented customer quota. Success includes the documented 2xx,
idempotent terminal, not-found, conflict, and typed business response where the
platform correctly evaluated the request.

Exclude customer-invalid authentication/input, deliberate customer quota/rate
limit violations, and synthetic/operator probes labeled before the window. Count
timeouts, unexpected 5xx, dependency failures, stale-route errors, and systemic
rate limiting. Planned maintenance is not automatically excluded.

Capacity rejection is reported separately and cannot be hidden as API success:
`eligible creates receiving a typed capacity rejection ÷ eligible create attempts`.
An alert fires before sold-out capacity becomes normal behavior.

### Machine-create success details

The denominator starts only after the scheduler admits the request and commits a
reservation. Platform success requires the requested VM to start, the guest agent
to respond, requested port checks to pass, and the control plane to persist
`running` with `ready=true` for the same lease generation.

The following count as platform failures: scheduler/host mismatch, artifact/cache
failure for a supported B.C template, VMM/jailer/network failure, lost observation,
control-plane timeout that later fails, and cleanup failure. Requests for an
unsupported OCI or managed-network source are rejected before admission and are
reported separately rather than entering this supported-source denominator.

Customer-attributable terminal outcomes after admission — customer cancellation,
customer quota or spend limits reached during startup, and post-admission
customer-invalid input — are neither platform success nor platform failure. They
are excluded from this numerator and reported separately with their own eligibility
rules, so a create that never reaches `ready=true` can never inflate create success.

Latency is not part of success until measured thresholds below are approved. The
distribution and timeout rate are still reported at p50/p95/p99/max.

### Gateway connection details

Measure from the gateway receiving an authorized attempt until HTTP response or
successful protocol upgrade to the current machine lease. Do not count invalid or
expired capabilities, wrong ports, stopped/not-ready machines, or client-cancelled
attempts before the server is ready. Count gateway/control lookup failure, wrong
host routing, overlay failure, upgrade/proxy error, or timeout.

Track established-stream unexpected termination separately by protocol, duration
bucket, deploy, host, and gateway instance. A reconnect that succeeds is useful
but does not erase the original interruption.

## Error budgets

A 99.9% request/connection target permits 0.1% bad eligible events per 30-day
window. A 99.0% create target permits 1% platform-failed admitted creates. Because
these are ratio objectives, “minutes of downtime” is only a rough translation;
for a continuously probed service 99.9% is about 43 minutes 50 seconds in 30 days.

Burn alerts use both a fast and slow window once traffic is sufficient:

- page on a high-confidence fast burn that would consume the 30-day budget within a day;
- create a high-priority incident on sustained multi-day burn; and
- keep low-traffic synthetic and real-request views side by side so a quiet beta
  cannot appear healthy merely because the denominator is zero.

When a journey exhausts its error budget:

1. stop risky releases and capacity reductions affecting that journey;
2. prioritize the largest measured failure class and its runbook/drill;
3. require reliability owner approval for unrelated production changes; and
4. resume normal change velocity after the rolling burn is controlled and the
   remediation has a regression test.

A security/isolation incident freezes launches regardless of remaining reliability
budget. Error budget cannot trade off a P0 security control.

## Performance indicators and baseline gate

Record JSON distributions with sample count, failures/timeouts, minimum, maximum,
median, p95, p99, standard deviation, host type, image/template digest, cold/cache
state, and build commit for:

- cold boot and snapshot restore to guest-agent ready;
- built-in runtime-cohort verification and reviewed template-replica preparation;
- first exec round trip;
- single fork and each child/all-ready batch fork;
- TTY and VNC connection setup;
- preview gateway overhead relative to direct private-host measurement;
- sequential/random disk performance;
- memory RSS versus configured guest memory; and
- machine stop/cleanup latency and orphan rate.

Fill target values from representative Latitude staging measurements, not marketing
guesses:

| Indicator                | Cohort                            | p50 target | p95 target | p99/timeout target | Baseline evidence |
| ------------------------ | --------------------------------- | ---------- | ---------- | ------------------ | ----------------- |
| Cold boot → ready        | B.C headless template             | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| Snapshot restore → ready | B.C headless template, cache warm | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| First exec               | Ready headless VM                 | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| Single fork → ready      | Supported forkable template       | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| Batch fork → all ready   | Approved batch size               | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| TTY / VNC setup          | Ready machine, by protocol        | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| Preview overhead         | Gateway minus private baseline    | `TBD`      | `TBD`      | `TBD`              | `TBD`             |
| Stop → capacity released | All supported sizes               | `TBD`      | `TBD`      | `TBD`              | `TBD`             |

A release benchmark compares like-for-like cohorts. Material regression threshold,
minimum sample size, and waiver owner must be set before making the benchmark a CI
gate. Failed/timed-out samples remain in the dataset.

## Operational health objectives

These are supporting indicators, not excuses to exclude customer failures:

- host heartbeat freshness and percentage ready/not draining;
- schedulable CPU, configured memory, disk, and warm-template headroom;
- control-plane/gateway/database saturation and queue depth;
- machine reconciliation age, orphan count, and cleanup backlog;
- audit and usage ingestion/projector lag;
- gateway active/failed sockets and bandwidth/conntrack saturation; and
- object replication, Stripe export, and webhook backlog.

Alert thresholds must link to the relevant runbook: [debug machine](runbooks/debug-machine.md),
[host loss](runbooks/host-loss.md), [capacity exhaustion](runbooks/capacity-exhaustion.md),
or [database outage](runbooks/database-outage.md).

## Measurement rules

- Use server-side telemetry for official SLIs and independent synthetic probes to
  detect telemetry/path failure. Compare them continuously.
- Propagate request, trace, organization, project, machine, lease, gateway, and
  host IDs without recording customer content or credentials.
- Define the eligibility/result label before evaluation. Unknown/missing result is
  a failure, not an exclusion.
- Keep raw events long enough to recalculate every active window and explain an incident.
- Segment by endpoint/protocol, region, host, size, supported template source, cache,
  image digest, and build. Publish only aggregates that meet privacy thresholds.
- Dashboard denominator, numerator, exclusions, no-traffic state, burn, and top
  failure classes. Do not average per-host percentages.

## Review and reporting

Review SLOs weekly during private beta and after every incident or material
architecture change. The weekly report includes current attainment, budget burn,
traffic/sample size, top failures, capacity rejections, performance baselines,
active remediation, and known measurement gaps. Any target/denominator change is
dated in version control and applied prospectively.
