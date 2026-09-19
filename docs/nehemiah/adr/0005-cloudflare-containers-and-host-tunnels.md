# ADR 0005: Control plane and gateway on Cloudflare Containers, hosts behind per-host tunnels

- Status: accepted for the Cloudflare deployment; ADR 0002 remains the contract for a self-hosted control plane
- Date: 2026-09-19
- Review trigger: a second region, a fleet large enough to need more than one gateway, or Cloudflare exposing inbound TCP/UDP to containers

## Context

The site already deploys to Cloudflare Workers with Alchemy (`apps/web/alchemy.run.ts`). The operator wants the rest of the managed cloud on Cloudflare too. `nehemiahd` cannot move: Firecracker needs bare metal with `/dev/kvm`, and Cloudflare Containers cap out at 4 vCPU / 12 GiB with ephemeral disk. The control plane (`apps/nehemiah`) and the public gateway (`gateway/`) can, but only if they can still reach hosts.

ADR 0002 makes the gateway and control plane the hub of a WireGuard overlay. Cloudflare Containers cannot be that hub: Cloudflare documents that nothing but the fronting Worker can reach a container, so there is no inbound UDP endpoint for hosts to peer with, and outbound UDP is undocumented.

## Decision

Run the control plane and the gateway as Cloudflare Containers, each owned by a Durable Object behind one edge Worker, and reach hosts through a Cloudflare Tunnel that each host runs itself.

- **Host identity does not change.** A host is still registered, validated, scheduled, and stored by its private overlay address (`hosts.address inet`). Only the transport to that address changes.
- **Deterministic tunnel hostnames.** A host's tunnel is published at `<label>.<host tunnel domain>`, where `label` is the dashed form of its overlay address (`10.64.0.7` → `10-64-0-7`; IPv6 fully expanded and dash-joined). The control plane and the gateway derive the hostname from the stored address; the operator configures the same hostname in `cloudflared` on the host. No lookup table exists to drift.
- **Cloudflare Access service tokens replace overlay reachability as the transport-layer gate.** A `*.<host tunnel domain>` Access application admits only the stack's service token, which the control plane and gateway send on every host request. Application-layer host credentials remain mandatory, as in ADR 0002.
- **Hosts reach the control plane over the public edge.** `NEHEMIAH_CONTROL_PLANE_URL` points at `api.<site>`. An Access application on `api.<site>/internal` admits only service tokens (the stack's, and the fleet token hosts present), so internal routes stay unreachable to the public even though the hostname is.
- **The gateway reaches the control plane the same way**, sending the stack's service token on internal routing calls.
- **The transport is selected by configuration** (`NEHEMIAH_HOST_TRANSPORT`, `NEHEMIAH_GATEWAY_HOST_TRANSPORT`). The default remains `overlay`, so a self-hosted control plane keeps ADR 0002 unchanged.
- **Hosts keep their WireGuard interface** so the overlay address exists locally for `nehemiahd` to bind; the hub peers simply never connect. The signed provisioning contract is untouched. Installing `cloudflared` and the fleet token on a host is an operator step in beta, like peer inventory under ADR 0002.

## Consequences

### Positive

- No VM remains outside Cloudflare and Latitude.
- Host reachability no longer depends on a hub's uptime or on UDP paths; `cloudflared` reconnects on its own.
- The same containers serve previews, REST, and streams; nothing about the public contract changes.

### Costs and constraints

- Cloudflare guarantees no container instance any particular lifetime. A restart drops every TTY/VNC stream the gateway holds; the existing drain and reconnect behaviour applies, and the control plane's Postgres-backed jobs are idempotent by design.
- Every stream crosses the edge twice (client to gateway container, container to host tunnel). Latency and egress rise accordingly.
- A wildcard below the site apex (`*.hosts.<site>`) needs Advanced Certificate Manager or its own zone.
- Container egress addresses are not stable. Host firewalls cannot allowlist the control plane by CIDR; `cloudflared` only accepts traffic from Cloudflare, and Access enforces the token.
- Cloudflare Access and Tunnel become part of the trust boundary and must be covered by the threat model's external-service review.

## Alternatives considered

- **Userspace WireGuard inside the containers.** Keeps ADR 0002 verbatim but depends on outbound UDP from containers, which Cloudflare does not document, and on the containers initiating to every host. Rejected until that capability is documented.
- **An overlay relay VM behind a tunnel.** Small code change, but leaves a VM in place, which is what this decision exists to remove.
- **Hostname-addressed hosts.** Replacing the `inet` column and the validation in three services with origin URLs is a schema and signed-contract change with no benefit over deterministic labels.

## Validation and operations

- From the public internet, `api.<site>/internal/*` and `*.<host tunnel domain>` return Access errors without a service token.
- The control plane's and gateway's unit tests pin the label mapping for IPv4, IPv6, and IPv4-mapped addresses.
- A host whose tunnel is down is marked stale by the existing heartbeat logic; no host-specific state lives in Cloudflare.
- Rotating the stack's service token is a redeploy; rotating the fleet token is a host-side change plus a policy update.
