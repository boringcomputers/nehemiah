# Runbook: capacity exhaustion

Use this runbook when no eligible host can safely place a machine, schedulable
headroom alerts fire, or typed capacity errors rise. Capacity pressure is never a
reason to overcommit configured memory, bypass quotas, schedule to unhealthy/
draining hosts, or disable isolation.

## Expected customer behavior

- A customer project/organization quota or rate limit returns the documented typed
  `429` response and limit metadata that is safe to expose.
- A healthy request that cannot fit on the regional fleet returns a typed
  `503 capacity_exhausted` (or the final documented equivalent), a request ID, and
  a `Retry-After` only when the service has a defensible estimate.
- The request creates no host runtime and leaves no partial or duplicate capacity
  reservation. Retrying an idempotency key resumes/returns the same operation semantics.

Do not turn capacity rejection into a generic timeout or repeatedly queue requests
with no bound.

## Diagnose the constraint

Record UTC window, region, sizes/templates/sources affected, error rate, queue age,
current deployment, provider status, and SLO impact. Inspect the scheduler's
recorded exclusion counts by:

- host ready/healthy/draining/stale/quarantined state;
- region and architecture;
- configured vCPU and memory reservation;
- disk/overlay/inode quota;
- built-in runtime-cohort or reviewed template-cache eligibility;
- per-project/organization concurrency and resource quota;
- gateway socket/bandwidth limit where the requested product requires it; and
- warm-pool versus hard physical capacity.

Configured guest memory is the reservation basis during beta. Do not substitute
host RSS or balloon telemetry to make a request fit.

## Distinguish real exhaustion from accounting failure

Before ordering capacity, compare three views:

1. PostgreSQL active reservations and scheduler locks;
2. host-reported current leases and configured resources; and
3. actual Firecracker scopes/cgroups/overlays and host filesystem/memory/CPU.

Investigate duplicate/stuck reservations, stopped/expired machines not finalized,
orphan runtimes, stale host heartbeats, incorrect size/template constraints,
replication backlog, disk/inode pressure, and a recent scheduler/config deploy.

If database and hosts disagree, stop risky placement for the affected cohort and
use the idempotent reconciler. Do not delete database reservations or host
processes manually to make graphs line up. If PostgreSQL is unhealthy, invoke the
[database-outage runbook](database-outage.md).

## Immediate containment

1. Confirm the scheduler continues to reject unsafe placements and no host exceeds
   CPU, configured memory, disk, PID, I/O, or connection policy.
2. Page the capacity owner and identify whether exhaustion is regional, one size,
   one template/image, one tenant quota, or one resource dimension.
3. Protect cleanup/reconciliation and existing customer streams from admission
   traffic using bounded queues and rate limits.
4. Publish a status update if platform capacity—not a customer's own quota—causes
   material rejection. Give the next update time, not an unverified recovery ETA.
5. Watch tenant retry storms and preserve idempotency; do not advise customers to
   generate new keys/IDs on every retry.

## Recover capacity safely

Apply the least disruptive valid option:

### Reclaim capacity already meant to be free

- Let TTL and authorized stop operations complete through the reconciler.
- Repair a stuck finalization only after host cleanup/current lease absence is
  proven; capacity and usage release remain idempotent.
- Drain/quarantine, rather than count, an unknown orphan until ownership is resolved.
- Restore a failed template replica/cache path if physical compute exists and only
  artifact eligibility blocks placement.

Never preempt a live, unexpired customer machine solely to admit another customer.

### Add approved Latitude capacity

Use the provider-neutral, manually approved beta provisioning workflow. Select the
supported region/hardware and immutable host-image version. Record approval,
provider request/idempotency ID, cost owner, expected resource addition, and rollback.

Before marking a host ready, require:

- exact host image/kernel/Firecracker/guest artifact checksum verification;
- unique host and WireGuard identity with tested revoke path;
- private-only `nehemiahd` reachability and current heartbeat/capacity;
- KVM, jailer, seccomp, cgroup, disk quota, firewall/deny-floor, time sync, logging,
  metrics, and orphan-reconciliation checks;
- disposable guest isolation and create/ready/exec/stream/stop smoke tests; and
- template/cache status accurately reported to the scheduler.

### Reduce new demand

Enforce the published per-project quotas, batch-fork bounds, rate limits, and spend
caps uniformly. Pause manual organization approvals or a high-cost feature through
an audited product control if needed. Do not secretly lower an existing customer's
quota or report platform shortage as customer abuse.

## Recovery verification

- [ ] Eligible synthetic and real creates succeed across each supported size/source.
- [ ] No host exceeds configured reservation or isolation/resource limits.
- [ ] Rejected requests left no runtime, reservation, audit, or metering anomaly.
- [ ] Reservation/host/process views reconcile and orphan/finalization queues are normal.
- [ ] Regional headroom exceeds the approved alert threshold for CPU, configured
      memory, disk/inodes, and gateway connections.
- [ ] New hosts passed full security/bootstrap evidence and are visible in monitoring.
- [ ] Capacity error rate and retry traffic return to baseline; status is updated.

## Follow-up and planning

Record demand by tenant/size/source, peak and sustained utilization, rejection
count/duration, time-to-detect, time-to-safe-headroom, provider lead time, and cost.
Update capacity alerts and the manual order threshold from measured lead time and
growth. Fix accounting/scheduler defects with concurrency regression tests. Static
fleet expansion remains manual for beta; do not add automatic scale-to-zero or
unreviewed provisioning during an incident.
