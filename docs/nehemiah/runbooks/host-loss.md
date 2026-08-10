# Runbook: host loss

Use this runbook when a Latitude host misses the configured heartbeat threshold,
its WireGuard path disappears, `nehemiahd` is unreachable, the provider reports
hardware failure, or host integrity is suspect.

Nehemiah does not live-migrate private-beta machines. Ephemeral state on an
unrecoverable host is lost, and managed durable volumes are not supported.
Never claim a lost machine recovered under the same lease generation.

## Invariants

- Stop new placement before attempting recovery.
- Distinguish a host failure from a fleet-wide gateway, WireGuard hub, control-plane,
  database, or telemetry failure.
- The control plane remains authoritative for intent; a returning host cannot make
  its stale runtime current.
- Route/capability invalidation, capacity release, terminal lifecycle, audit, and
  final metering happen idempotently once.
- A suspected-compromised host is revoked and rebuilt, not placed back into service.
- Do not expose host identity/topology or another tenant's impact in customer messages.

## Trigger and severity

Open an incident when any of these occurs:

- heartbeat age crosses the stale/unhealthy alert threshold;
- several machine streams/operations fail on one host;
- the provider reports power, disk, network, or hardware failure;
- tunnel identity unexpectedly changes or authentication/replay alerts fire; or
- isolation, credential, root-login, or unexpected-process evidence suggests compromise.

Treat confirmed/suspected compromise or cross-tenant exposure as a security
incident. Otherwise severity follows affected machines/customers, duration,
remaining regional headroom, and SLO burn.

## Immediate response

1. Record incident ID, UTC start, environment/region, host ID, last heartbeat,
   current boot/daemon/overlay identity, deployed image/checksums, and alert links.
2. Mark the host ineligible/unhealthy (and draining where the model permits) so the
   scheduler cannot create new reservations. Confirm the decision reached every scheduler worker.
3. List affected current lease generations from the control plane. Do not query or
   disclose customer payload/content.
4. Check whether other hosts lost heartbeat at the same moment and whether gateway,
   WireGuard hubs, control plane, database, and telemetry are healthy.
5. Preserve provider console/host telemetry. Avoid restart, reprovision, or disk
   replacement until compromise/evidence needs are assessed.

If control-plane/database state is unavailable, also invoke the
[database-outage runbook](database-outage.md). Hosts must still enforce existing
TTL and local cleanup, but do not invent terminal control-plane transitions offline.

## Confirm the failure domain

Use independent signals:

| Signal                        | Host failure likely            | Shared-path failure likely                |
| ----------------------------- | ------------------------------ | ----------------------------------------- |
| Latitude power/hardware state | One host absent/faulted        | Provider-wide incident                    |
| WireGuard handshake           | One peer stale                 | Hub/all peers stale                       |
| Host heartbeat                | One host stale                 | Ingestion/control plane stale for many    |
| Guest/gateway streams         | Mapped leases on one host fail | Many hosts/gateways fail                  |
| Out-of-band host access       | Host unavailable or unhealthy  | Reachable host with overlay/service issue |

Do not declare machines lost merely because one telemetry pipeline is delayed. Use
the configured lease/heartbeat thresholds and at least one independent signal.
If `nehemiahd` alone failed but sibling Firecracker scopes and the host are healthy,
follow restart reconciliation first; keep the host drained during the test.

## Contain and reconcile

### Unreachable or failed host

1. Keep placement disabled and invalidate bounded gateway routes to the affected
   current leases. New stream/preview capability issuance must fail.
2. After the configured loss threshold, have the reconciler append `lost` for each
   affected active machine with incident/host/last-observation references.
3. Close each usage lease at its last defensible checkpoint or enforced boundary,
   flag uncertainty, and queue ambiguity for review—never fill the gap to “now.”
4. Release scheduler reservations exactly once and verify no healthy host acquired
   the same lease/public machine mapping.
5. Expire outstanding capabilities and notify affected customers with machine IDs,
   timestamps, ephemeral-loss semantics, and next action, not host details.

### Suspected compromise

In addition to the steps above:

1. Revoke the host's application and WireGuard identities and any outstanding
   short-lived object credentials.
2. Remove its overlay route at all peers and inspect denied/accepted control-plane,
   gateway, object-store, and credential events for its identity.
3. Preserve approved forensic host metadata/snapshots under incident access and
   retention rules. Do not copy customer disks/content without legal/security approval.
4. Rotate any credential whose scope or presence on the host is uncertain.
5. Reimage from a verified artifact before reuse; do not “clean” in place.

## Restore regional capacity

Check configured CPU, memory, disk, warm-template, and connection headroom after
reservation release. If remaining healthy hosts can safely absorb normal demand,
continue with reduced fleet and increased monitoring. Otherwise invoke
[capacity exhaustion](capacity-exhaustion.md) and use the approved Latitude adapter
workflow to provision a replacement.

A replacement must pass bootstrap identity, WireGuard reachability, KVM/jailer/
seccomp/cgroup/quota/firewall checks, exact image checksum verification, isolation
evidence, heartbeat freshness, and a staging smoke create/ready/exec/stop before it
becomes schedulable. Do not reduce isolation or memory reservation to gain capacity.

## If the host returns

The host stays quarantined and unschedulable. Compare provider instance/hardware,
host image, boot ID, WireGuard key, daemon identity, state snapshot, systemd scopes,
Firecracker processes, sockets, cgroups, taps, overlays, and lease generations.

- A runtime whose lease was marked `lost` is stale. Block customer routing and
  terminate it through the approved orphan cleanup after evidence needs are met.
- A runtime still within a not-yet-lost current lease may reconnect only through
  the normal restart reconciler and only before the loss decision; never manually
  change its generation.
- Any identity/integrity mismatch turns the event into suspected compromise and
  requires rebuild.

Only return the host to ready placement after root cause is understood, repairs
and regression/isolation tests pass, credentials are current, heartbeats are
stable for the approved observation period, and the incident commander approves.

## Customer and status communication

State what customers observe, affected region/product, incident start, mitigation,
ephemeral-machine loss semantics, and next update time. Do not imply unsupported
durability, promise recovery of a lost machine, or expose tenant/host topology. Send direct machine-specific notices
through authenticated channels when possible.

## Recovery checks

- [ ] Failed host is ineligible at every scheduler and absent from new placements.
- [ ] Every affected current lease has one honest terminal state and route invalidation.
- [ ] Capacity reservations and final usage/audit events finalized exactly once.
- [ ] No stale runtime became reachable after the host or tunnel returned.
- [ ] Regional headroom and SLOs are stable; replacement hosts passed security checks.
- [ ] Customer/status updates and support guidance are current.
- [ ] Root cause, timeline, detection/response gaps, and remediation owners are recorded.

## Drill record

For a staging drill, record host/build IDs, failure injection, affected synthetic
leases, detection time, placement-stop time, `lost` decision time, route revoke,
capacity release, replacement placement, final ledger totals, customer-simulation
result, unexpected behavior, and links to retained test/telemetry evidence. Never
run a production failure injection without approved change/incident coordination.
