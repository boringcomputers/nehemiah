# Runbook: debug a Nehemiah machine

Use this runbook when one machine cannot create, become ready, exec, connect,
preview, extend, fork, or stop. For fleet-wide symptoms, start the linked incident
runbook instead: [host loss](host-loss.md), [capacity exhaustion](capacity-exhaustion.md),
or [database outage](database-outage.md).

## Safety rules

- Use the public machine ID, request/trace ID, and control-plane lease generation.
  Do not ask a customer for a host-local ID, raw API key, cookie, or preview token.
- Start with read-only control-plane and telemetry views. Production host shell
  access requires the approved access path and an audit/ticket reference.
- Never read or copy command bodies, terminal bytes, files, environment values,
  browser state, memory snapshots, or guest-console output unless the customer explicitly
  consents through the approved time-bounded content-access process.
- Do not paste secrets, signed URLs, WireGuard configuration, database rows, or
  customer content into chat, issues, or the incident timeline.
- Do not change the database by hand, reuse a lease, attach a machine to a new
  host, or force a terminal state to look healthy. Prefer the idempotent reconciler.
- If there is any sign of guest escape, cross-tenant routing, secret exposure, or
  unauthorized access, stop ordinary debugging and invoke the security incident process.

## Gather before starting

Record in the support/incident ticket:

- environment/region and UTC symptom window;
- public machine ID and operation (`create`, `ready`, `exec`, `tty`, `vnc`,
  `preview`, `extend`, `fork`, or `delete`);
- request/trace ID and idempotency key prefix or operation ID if available;
- organization/project IDs from the authenticated internal view;
- expected result, actual status/error code, and whether retry returns the same result;
- built-in or reviewed immutable template version, resolved rootfs/runtime-cohort
  digests, size, ports/readiness policy, and the enforced `off` network policy,
  without secret values; and
- scope: one request, one machine, one host/template/size/tenant, or fleet-wide.

If ownership cannot be established from the authenticated ticket and authoritative
record, do not expose machine details.

## Fast triage

| Symptom                            | First check                                                                      | Escalate to                    |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| Create rejected before `requested` | API/auth/quota/idempotency response and database health                          | Database or identity owner     |
| Stuck `requested`/`placing`        | Scheduler queue, transaction/lock, reservation, eligible-host reasons            | Capacity runbook if fleet-wide |
| Stuck `starting`                   | Host command result, lease generation, Firecracker/agent/readiness timeline      | Host/runtime owner             |
| `running` but `ready=false`        | Latest guest-agent and requested-port probe, network/image change                | Guest-agent/image owner        |
| Exec/file/PTY fails                | Current readiness, agent connection, bounds/timeout, lease route                 | Host or gateway owner          |
| TTY/VNC/preview fails              | Capability audience/expiry, registered port, gateway route, overlay              | Gateway owner                  |
| Stuck `stopping`                   | Stop operation, host observation, orphan cleanup, reservation/usage finalization | Reconciliation owner           |
| `lost`                             | Host-loss incident, terminal cleanup, and ephemeral-disk loss                    | Host-loss runbook              |

## Procedure

### 1. Confirm authoritative identity and state

In the read-only admin/control-plane view, locate the resource by public machine ID
and verify:

- organization/project ownership;
- desired state, lifecycle state, state version, and terminal reason;
- public machine ID → lease ID/generation → host ID → host-local mapping;
- `started_at`, current `ready`, `ready_at`, and latest readiness observation;
- created/expiry timestamps and current TTL/extension operation;
- template/image digest, requested size, network/port policy; and
- capacity reservation and finalization flags.

If two current leases, host mappings, or overlapping active reservations exist for
one machine generation, declare an incident. Do not choose one manually.

### 2. Reconstruct the event timeline

Join structured telemetry by request/trace, public machine, operation, lease
generation, and host IDs. Build a UTC timeline of:

1. authenticated request and authorization result;
2. idempotency record and committed intent;
3. scheduler candidates, exclusion reason, reservation commit;
4. host command send/accept/response;
5. host process start, guest-agent connect, readiness probes;
6. control-plane state projection and gateway route/capability; and
7. stop/expiry, capacity release, audit, and usage checkpoint/finalization.

Use IDs and result classes, not customer payload. Missing spans/events are part of
the diagnosis; do not infer success from absence.

### 3. Check whether the failure is broader

Compare the same endpoint, host, template/digest, size, gateway, and region over
the symptom window. Check SLO burn, deployment markers, host heartbeat/tunnel
health, scheduler capacity, database latency, guest-agent reconnect,
and gateway error/socket saturation.

- Several hosts plus control-plane errors: treat as dependency/database/control-plane incident.
- One host or tunnel: drain it and use the host-loss procedure if heartbeats expire.
- One template/digest: quarantine new placements from that artifact and notify the image owner.
- One tenant: verify quota/rate policy and authorization without revealing another tenant's data.

### 4. Diagnose by lifecycle boundary

#### `requested` or `placing`

Verify the idempotency request hash matches, the scheduler job is claimed once,
the database transaction completed, and candidates were excluded for recorded
reasons (region, architecture, health/drain, CPU, configured memory, disk, quota,
template/image). Confirm one reservation or none—never more than one.

A typed quota or capacity response is not repaired by bypassing limits. If the
fleet is genuinely full, follow [capacity exhaustion](capacity-exhaustion.md).

#### `starting`

Confirm the host authenticated the current lease/operation, then distinguish:

- artifact pull/checksum/cache failure;
- overlay/quota, cgroup, tap/firewall, jailer, KVM, Firecracker API, or systemd-scope failure;
- process started but guest agent never connected;
- agent connected but requested readiness failed; or
- host succeeded after the control-plane request timed out.

Re-run the idempotent reconcile operation; do not issue a new create with a new
lease unless the original is terminal and its cleanup/capacity release is proven.

#### `running` or `ready=false`

Check the latest agent liveness sequence, host boot ID, persisted socket metadata,
requested port probe, resource-limit hits, disk-full signal, and managed
egress-off/DNS-denial evidence. A post-start readiness loss updates `ready=false`;
it does not regress the machine to `starting`.

For exec/file/PTY, check protocol version, request bounds, concurrency, timeout,
cancellation/disconnect, and separate stdout/stderr result metadata. Managed VMM
stdio is null: there is no tenant or operator serial fallback. If the guest agent
is unavailable, preserve the typed `503` evidence and repair or replace the guest
artifact through the approved lifecycle path.

#### Stream or preview

Confirm the capability has the correct tenant, machine, lease generation,
audience, operation/registered port, and expiry. Then verify the gateway used the
control-plane-selected upstream, the host mapping is current, WireGuard is healthy,
and the guest port is listening/ready. Inspect status and byte counts only—not
headers/cookies/body content beyond the allowlisted diagnostic schema.

Never extend a token or point the gateway at an arbitrary host/URL to test around
an authorization or SSRF denial.

#### `stopping`, `failed`, or `lost`

For `stopping`, locate the repeated idempotent stop observation and inspect scope,
process, socket, cgroup, tap, overlay, and quota cleanup flags. Capacity and final
usage must release once after defensible cleanup/terminal reconciliation.

`failed` and `lost` are terminal. Explain the recorded reason and cleanup status;
do not rewrite them to `running`. If a lost host returns, its runtime is quarantined
and handled by the host-loss runbook.

### 5. Inspect a host only when necessary

Use the approved host-access workflow. Read-only checks commonly include:

```bash
systemctl is-active nehemiahd
systemctl status nehemiahd --no-pager
journalctl --unit nehemiahd --since '<UTC start>' --until '<UTC end>' --output json
wg show
systemctl list-units --type=scope --all
systemd-cgls
```

Filter the structured journal locally by the non-secret machine/lease/trace IDs and
retain only approved metadata. Scope names and local runtime paths are deployment
details; obtain them from the authoritative host observation rather than guessing.
Do not alter the managed launch to attach a serial console, mount a customer disk,
copy a snapshot, dump process memory, alter firewall/cgroup state, or restart the
daemon merely to “see if it helps.” A restart is a controlled drill/remediation
and must first preserve the reconnect evidence.

### 6. Choose a safe action

| Condition                                                | Safe action                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Repeated request with same payload                       | Return/resume the stored idempotent operation                                              |
| Host succeeded after API timeout                         | Reconcile the same lease and public machine ID                                             |
| Host never accepted current lease                        | Release reservation once, then terminally fail/retry according to operation policy         |
| Machine is expired or stop intent exists                 | Retry idempotent stop/cleanup for the current lease                                        |
| Host is unhealthy/draining                               | Prevent new placement; use host-loss/drain procedure                                       |
| Template/image integrity failure                         | Quarantine digest, fail closed, use known-good immutable version                           |
| Gateway route/capability stale                           | Invalidate bounded route cache; issue only a newly authorized short-lived capability       |
| Resource limit correctly hit                             | Report typed limit; change quota/size only through authorized audited control-plane action |
| Suspected platform defect with running customer workload | Preserve metadata, limit blast radius, escalate; do not inspect customer content           |

### 7. Verify and close

Confirm the user-visible operation, authoritative state, host observation, route,
capacity reservation, TTL, audit event, and usage high-water mark agree. Verify
there is no orphan runtime or duplicate child/reservation. Record root cause,
scope, safe action, customer impact, exact evidence links, and regression test or
follow-up owner.

Escalate when the same unknown failure appears twice, reconciliation age exceeds
its alert threshold, a terminal machine still consumes capacity, usage/audit is
missing, or any isolation/authorization invariant is uncertain.
