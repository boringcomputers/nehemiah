# Nehemiah managed-cloud architecture

Status: accepted for implementation  
Last updated: 2026-08-09

This document freezes the private-beta system contract. It describes the managed
service that grows out of the one-host prototype in [the repository architecture](../architecture.md).
Implementation details may change, but changes to the decisions and invariants
below require an ADR.

## Product and deployment boundary

Nehemiah provides forkable, hardware-isolated computers for AI agents: shell,
code execution, browser/desktop access, files, snapshots, batch forks, and live
previews through one machine API.

Private beta is deliberately bounded to:

- one production region with at least three statically provisioned Latitude hosts;
- ephemeral machines and bounded file transfer; managed durable volumes are disabled;
- headless and desktop machine sizes with hard project quotas;
- a Cloudflare-fronted public gateway and control plane; and
- manual capacity approval and host provisioning.

Multi-region scheduling, live migration, GPUs, public template marketplaces,
enterprise SSO, and automatic bare-metal scale-to-zero are outside this contract.

## Decisions

- [`apps/nehemiah` owns the control plane; `nehemiahd` owns one host's data plane](adr/0001-control-and-data-plane.md).
- [The beta private host network is a WireGuard hub-and-spoke overlay](adr/0002-host-connectivity.md).
- [Clerk authenticates dashboard users; B.C issues programmatic API keys](adr/0003-tenant-identity.md).
- [Billable usage is recorded in an append-only, idempotent ledger](adr/0004-metering-ledger.md).

## System context

```text
SDK / CLI / MCP / dashboard / preview visitor
                       |
                 Cloudflare edge
                       |
              +--------+---------+
              |  public gateway  | REST, WebSocket, preview proxy
              +---+-----------+--+
                  |           |
                  |           | private route lookup and machine streams
                  v           v
          +----------------+  WireGuard overlay
          | apps/nehemiah  |       |
          | control plane  |       +---------------+
          +--+---+---+-----+                       |
             |   |   |                        +----+------+
             |   |   +---- Stripe             | nehemiahd | Latitude host A
             |   +-------- Clerk               +----+------+
             |                                     | vsock
             v                                     v
       PostgreSQL <----> object storage       Firecracker guests
             ^                                     ^
             |                                +----+------+
             +---------- control plane -------| nehemiahd | Latitude host B/C
                       over WireGuard          +-----------+
```

Only the edge, gateway, and intended control-plane HTTP routes are publicly
reachable. A Latitude host has no public customer API. `nehemiahd` binds its
internal API to its WireGuard address and accepts only an authenticated control
plane or gateway peer. Guest networks are never routed onto the host overlay.

### Components and ownership

| Component        | Responsibility                                                                                                                     | Durable authority                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cloudflare edge  | DNS, TLS, DDoS/WAF controls, request limits, wildcard preview ingress                                                              | No                                                              |
| Public gateway   | Authenticate requests, authorize a route, proxy REST/TTY/VNC/files/previews, enforce connection limits                             | No; route caches are bounded and disposable                     |
| `apps/nehemiah`  | Organizations, projects, keys, desired machine state, scheduling, leases, quotas, templates, usage, billing, audit, reconciliation | Yes, through PostgreSQL                                         |
| PostgreSQL       | Transactional source of truth and append-only event ledgers                                                                        | Yes                                                             |
| `nehemiahd`      | Host capacity, Firecracker lifecycle, local cache/overlays, cgroups, network policy, guest-agent transport, observed runtime       | Only host-local recovery metadata; not tenant intent            |
| B.C guest agent  | Readiness, exec, PTY, file transfer, cancellation, and liveness over vsock                                                         | No                                                              |
| Object storage   | Retained release/template artifacts; managed volume objects are disabled for beta                                                  | Yes, for supported immutable artifacts                          |
| Latitude adapter | Provision, inspect, drain, and retire beta hosts behind a provider-neutral interface                                               | Provider inventory only                                         |
| Clerk            | Authenticate human dashboard sessions                                                                                              | External identity only; B.C authorizes membership and resources |
| Stripe           | Receive aggregated billable usage and payment events asynchronously                                                                | Billing processor, not runtime authority                        |

Serial remains a local/self-hosted transport. Managed customer exec, PTY,
readiness, and file operations use the guest agent and return a typed failure if
it is unavailable; no public managed path falls back to the recovery console.

Public REST admission has two independent layers. The gateway derives a client
address from the direct TCP peer, or from one configured single-value header only
when that peer belongs to a trusted public-edge CIDR. A fixed-size local slot
table limits that coarse `/24` or `/56` identity before proxying. The gateway
removes caller-supplied forwarding values and HMAC-authenticates the derived
address to the control plane; an invalid or stale handoff falls back to the
control plane's direct peer.

Before API-key Argon2 verification, the control plane atomically consumes global
PostgreSQL windows for the coarse source and the coarse-source/public-key-prefix
pair. Pairing prevents disclosure of a public prefix from becoming a global
denial primitive. After authentication it consumes principal, organization, and (when the
credential is project-scoped) project windows in one statement. PostgreSQL stores
only a 20-bit hash slot, scope, window, and count—never an address, principal ID,
or credential. The five fixed slot spaces bound cardinality; collisions fail
conservatively. Production refuses disabled or fail-open admission, and every
rejection returns `429` with `Retry-After`.

On managed hosts, each jailer/Firecracker process runs in the exact sibling
scope `nehemiah-vmm-<host-local-machine-id>.scope` under `system.slice`.
The scope—not the daemon process—owns CPU, memory, PID, swap, and block-I/O
limits. Firecracker inherits null stdio, while customer terminals open a fresh
framed PTY stream through the guest agent over vsock. A daemon restart can
therefore kill the complete `nehemiahd.service` cgroup, prove the persisted
scope/PID/socket/lease identity, and reconnect without depending on lost pipes.
Unknown scopes and duplicate processes are stopped during startup reconciliation.

## Identifiers and tenancy

Every customer-owned record is rooted in an organization and project. A public
machine ID is globally unique but is never an authorization mechanism. The
control plane maps it to:

- the owning organization and project;
- a control-plane lease ID and operation generation;
- the selected host ID; and
- a host-local machine ID that is never returned to customers.

All resource reads and writes perform an ownership lookup in the authenticated
organization/project context. Host requests contain opaque lease and operation
identifiers, never Clerk sessions, customer API keys, or provider credentials.

## Machine lifecycle

The persisted lifecycle states are:

| State       | Meaning                                                                             | Normal next states                      |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| `requested` | Intent and idempotency record committed; no capacity is reserved yet                | `placing`, `stopping`, `failed`         |
| `placing`   | Scheduler is transactionally selecting and reserving a host                         | `starting`, `stopping`, `failed`        |
| `starting`  | A host accepted the lease and is creating or restoring the VM                       | `running`, `stopping`, `failed`, `lost` |
| `running`   | The VM started and has passed initial guest-agent and requested-port readiness      | `stopping`, `lost`                      |
| `stopping`  | Stop intent is committed and cleanup is being retried                               | `stopped`, `failed`, `lost`             |
| `stopped`   | Host cleanup and capacity release are confirmed; terminal                           | —                                       |
| `failed`    | The requested operation cannot complete and cleanup/release is finalized; terminal  | —                                       |
| `lost`      | The assigned host can no longer authoritatively report or clean up the VM; terminal | —                                       |

`started_at`, `ready`, `ready_at`, and the latest readiness probe are distinct
from lifecycle state. A Firecracker process can be started while the machine is
still `starting`. Initial transition to `running` requires the guest agent and all
requested readiness checks. If readiness is later lost, `ready` becomes false
without pretending the machine never ran; reconciliation either restores
readiness, stops it, or marks it failed/lost as appropriate.

Terminal records do not regress to active states. Retry or recovery that creates
a new runtime uses a new lease generation. In particular, a machine declared
`lost` is never later presented as recovered.

## Consistency and reconciliation

The control plane owns intent. The assigned host owns observed runtime. Neither
may silently overwrite the other's facts.

1. The control plane commits desired state, an operation record, and any capacity
   reservation before calling a host.
2. A host accepts a command only for its authenticated, current lease and records
   the observed result locally before acknowledging it.
3. The control plane appends machine events and updates its current-state
   projection after receiving or polling host observations.
4. The reconciler compares desired state, lease generation, host observation,
   heartbeats, and timeouts, then retries an idempotent action or makes an honest
   terminal transition.
5. Capacity reservations and final usage are released/emitted exactly once using
   unique database constraints, even when requests, heartbeats, or jobs repeat.

Unknown host resources are quarantined from customer traffic and then cleaned up
according to the orphan policy. Missing resources for a current lease become
`failed` during startup or `lost` after they have run. A stale/unhealthy/draining
host receives no new placement. Loss of PostgreSQL fails closed for new creates
and authorization-changing operations; it must not create unaudited machines.

## Idempotency contract

Managed create, extend, and fork requests require an idempotency key. Delete is
naturally idempotent by machine ID and also accepts a key for end-to-end tracing.
Keys are scoped to the authenticated organization, project, operation, and route.
The control plane stores the key with a canonical request hash and the stable
operation/resource result.

- **Same key, same canonical request:** return or resume the original operation.
  Retries reuse the public machine ID, lease generation, placement reservation,
  and child ID for a fork.
- **Same key, different request:** return `409 idempotency_conflict`; never mutate
  the first operation.
- **Create:** intent and public ID are allocated once. A timeout may reconcile to
  the machine that the host actually created; it never creates a second VM.
- **Delete:** repeated calls converge on stopped. A missing host runtime is a
  successful cleanup observation when the lease matches, not a reason to recreate.
- **Extend:** the first request stores an absolute resulting expiry, so retries do
  not add the duration again.
- **Fork:** the first request stores the child ID(s). Batch fork is all-or-cleanup:
  every child becomes ready or all created children are stopped and the operation
  fails with its cleanup status recorded.

Idempotency records live at least as long as the maximum client retry window and
until the referenced operation is terminal. SDKs generate keys by default. Host
commands also carry a unique operation ID so control-plane retries are safe.

## Scheduling and capacity

The scheduler filters for region, architecture, machine size, template/image
availability, health, draining state, and hard CPU/memory/disk quotas. It reserves
capacity in one PostgreSQL transaction with row or advisory locks, then prefers a
host with the requested immutable template cached and uses best fit. Failed host
create calls either reconcile the accepted lease or release its reservation once.

Configured memory is reserved in full for beta. Firecracker balloon/free-page
telemetry may inform a later policy, but memory is not overcommitted until stress
tests establish a safe bound. A full fleet returns a typed capacity error and
does not partially overcommit a host.

## Images, storage, and network policy

Machines start from a release-bound immutable B.C built-in template, or from an
existing reviewed immutable template record where the operator has provisioned
one. The host and lease persist the exact runtime cohort/rootfs digest. Managed
OCI import, custom-template publication, and durable volume create/attach/save
are disabled for the private beta. Their dormant implementations cannot be
enabled until the quota, retention, and transport prerequisites in
[implementation status](implementation-status.md) are complete.

Guest networking is code-enforced to `mode=off` for the private beta. A
non-overridable platform floor still blocks IPv4 and IPv6 loopback, link-local,
metadata, RFC1918, unique-local, CGNAT, host, control-plane, overlay, and
peer-tenant destinations. CIDR/hostname policy code remains dormant until hard
organization, project, and host-network traffic quotas plus a connection-aware
hostname proxy are implemented. Public ingress is capability-scoped and routed
only by the gateway to a registered machine port.
Gateway termination first stops new REST and capability admission, then drains
tracked HTTP and hijacked WebSocket streams for the configured grace period;
remaining upgraded streams are explicitly cancelled before process exit.
Each managed tap is bound to its assigned IPv4 address before either host or
forwarded traffic is accepted. The host installs a per-tap 128-connection TCP
ceiling, packet-rate guards, and a 64 Mbit/s traffic-control policer; failure to
install any identity, connection, packet, or bandwidth primitive leaves the tap
on a direct DROP rule (or takes the link down). These are beta safety ceilings,
not billable egress accounting; authoritative byte high-water metering remains a
separate required signal.

The control plane canonicalizes `network_policy` before hashing a create
operation, rejects every non-off managed policy before persistence, stores the
off policy with the lease, sends it on create recovery, verifies the
host-reported policy, and copies it unchanged to every fork child. Omission is
the explicit `{mode: "off"}` policy; it never means unrestricted egress.

## Availability and data semantics

Ephemeral machine state can be lost with a host; private beta makes no live
migration or durable-storage claim. Host loss
marks affected machines `lost`, emits their final usage boundary, releases their
reservations once, and moves new placements to healthy hosts.

The database is the source of truth. Retained release storage is the source for
supported immutable artifacts. Caches, gateway routes, and host-local
template replicas are reconstructable. Stripe is never on the machine lifecycle
critical path.

## Security and observability invariants

- Firecracker jailer, seccomp, dedicated identities, cgroup CPU/memory/PID/I/O
  limits, overlay quotas, TTL reaping, and network isolation are mandatory in
  managed mode.
- User keys are shown once and stored only as a prefix plus Argon2id hash.
- Provider, Stripe, database, object-storage, host, and signing credentials are
  separate, scoped, rotated, and never delivered to a guest.
- Request, operation, machine, lease, host, organization, and project IDs are
  propagated through structured logs, traces, metrics, audit, and ledger events.
- Authorization headers, query tokens, command bodies, terminal bytes, file
  contents, and customer environment values are not logged by default.
- Every privileged or customer-visible mutation produces an append-only audit
  event. Every billable interval produces an idempotent usage event.

Public exposure is gated by the [threat model](threat-model.md) and an
evidence-complete [security checklist](security-checklist.md). Operational targets
and failure procedures live in [the SLO document](slo.md) and
[runbooks](runbooks/).

## Wire contracts and portability

OpenAPI generated from server types is the managed wire-contract source. Node,
Python, and Go wire models are generated or validated against it; ergonomic SDK
wrappers sit above those types. The same high-level `Machine` API targets local
`nehemiahd`, self-hosted endpoints, and Nehemiah. A target that lacks a feature
returns a typed `NotSupported` error.

`Nehemiahfile` is the portable declarative environment description for image,
resources, network policy, ports/readiness, setup, persistence, and forkability.
It contains no provider-specific host identity or secret values.

## Change policy

The following require a new or superseding ADR: authority boundaries, host
connectivity, tenant identity, key storage, lifecycle states, readiness semantics,
idempotency scope, ledger mutability, or the hard network-deny floor. The ADR must
include a migration and rollback plan for any persisted or public contract.
