# ADR 0001: Separate control and data planes

- Status: accepted
- Date: 2026-08-08
- Decision owners: Nehemiah engineering

## Context

The prototype exposes a single `nehemiahd` process that both accepts customer
requests and owns Firecracker children on one host. A managed, multi-tenant fleet
needs durable tenant identity, transactional placement, quotas, billing events,
host-loss reconciliation, and a public streaming gateway. Making every host a
copy of that global authority would create split-brain ownership and expose host
details to customers.

The host process still needs to make local decisions synchronously: it is the
only component that can inspect Firecracker processes, sockets, cgroups, overlay
files, taps, guest-agent liveness, and actual resource use.

## Decision

Use three explicit runtime roles:

1. `apps/nehemiah`, implemented in TypeScript/Effect, is the central control
   plane. PostgreSQL behind it is the source of truth for organizations, projects,
   public resources, desired machine state, host inventory, capacity reservations,
   leases, quotas, usage, and audit events.
2. `nehemiahd`, implemented in Go, is the per-host data plane. It owns local
   Firecracker lifecycle, isolation, networking, cache/overlay management,
   guest-agent transport, and observed runtime. It persists only enough local
   lease metadata to reconnect and reconcile after restart.
3. A Go public gateway authenticates and routes customer REST, WebSocket, and
   preview traffic. It obtains tenant-authorized route decisions from the control
   plane and then talks to a host over the private network. It is not a source of
   truth.

The control plane commits intent before a host side effect. Every host operation
carries an opaque lease generation and idempotent operation ID. Host observations
never directly rewrite desired state; the control-plane reconciler compares the
two and appends a state transition. A host does not store or accept customer API
keys.

## Consequences

### Positive

- Tenant authorization, capacity, and audit rules have one transactional authority.
- Hosts can restart and reconcile without pretending local observations are global intent.
- Customer traffic never needs a host address or host credential.
- The control plane, gateway, and host agent can scale and fail independently.
- The Latitude implementation stays behind a provider-neutral capacity interface.

### Costs and constraints

- Lifecycle operations are distributed workflows and need idempotency,
  reconciliation, timeouts, and explicit `lost` semantics.
- Streaming paths require a fast, bounded route lookup/cache in the gateway.
- PostgreSQL unavailability must fail closed for new or authorization-changing
  operations; no host may independently accept customer creates.
- Contract tests and version negotiation are required between the control plane,
  gateway, and `nehemiahd`.

## Alternatives considered

- **Expose every `nehemiahd` directly.** Rejected because it leaks fleet topology,
  distributes tenant secrets, and cannot transactionally prevent overcommit.
- **Make hosts peers in a distributed database.** Rejected for beta because the
  consensus and partition semantics add risk without improving the product boundary.
- **Put Firecracker lifecycle in the TypeScript service.** Rejected because local
  process, socket, cgroup, and streaming ownership is safer and simpler in the Go
  host daemon.
- **Adopt Kubernetes as the control plane.** Rejected for the initial product:
  Nehemiah schedules hardware-isolated microVMs with snapshot/fork semantics, and
  still needs its own tenant, lease, ledger, and public contracts.

## Validation

- A create timeout test proves that one public machine ID maps to at most one
  current host lease.
- Restart tests prove `nehemiahd` reconnects to sibling Firecracker systemd scopes
  and reports observations without changing intent.
- Host-loss tests prove new placements avoid the host and affected machines become
  `lost` rather than falsely recovered.
- Tenant isolation tests prove no host-local identifier or endpoint grants access.
