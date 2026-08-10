# ADR 0002: WireGuard private host connectivity for beta

- Status: accepted for private beta
- Date: 2026-08-08
- Review trigger: a second region, materially larger fleet, or managed-network requirement

## Context

The gateway and control plane must reach `nehemiahd` on Latitude bare metal, but
customers must not see or connect to host APIs. Latitude capacity may span
networks that do not provide one uniform private VLAN. Public TLS endpoints on
every host would increase exposed surface and make fleet revocation dependent on
internet firewall correctness.

## Decision

Use a WireGuard hub-and-spoke overlay between the gateway/control-plane network
and each Latitude host for private beta.

- Every host has a unique WireGuard key, a unique overlay address, and a separate
  application-layer host credential.
- Hosts peer with redundant gateway/control-plane overlay endpoints. Hosts do not
  receive routes to other hosts, guest subnets, the database, or provider networks.
- `nehemiahd` binds its internal listener to the overlay address. Host firewalls
  allow its ports only from the designated gateway/control-plane peers.
- Guest taps/namespaces cannot route onto the WireGuard interface. The guest hard
  deny floor blocks overlay, host, control-plane, peer-tenant, metadata, private,
  loopback, link-local, CGNAT, and unique-local ranges for IPv4 and IPv6.
- WireGuard provides a private encrypted transport, not complete service identity.
  Each registration, heartbeat, command, and route request also authenticates the
  host/peer at the application layer and carries a current lease generation.
- Host keys and application credentials are rotated independently. Draining and
  revocation remove the peer and revoke the host credential; either action is
  sufficient to prevent new work.
- Beta peer allocation and rotation may be operator-managed from a reviewed
  inventory. The provider adapter can automate the same contract later.

The public gateway remains behind Cloudflare. Direct host public ingress is
denied even if a host also needs outbound internet access for bootstrap, artifact
pulls, heartbeats, or updates.

## Consequences

### Positive

- Host APIs are absent from the public routing surface.
- Encryption and network allowlisting do not depend on Latitude topology.
- A compromised or retired host can be removed with a peer and credential revoke.
- The solution is provider-neutral and small enough to operate during beta.

### Costs and constraints

- Peer inventory, address allocation, rotation, MTU, and redundant hubs require
  explicit automation and monitoring.
- Overlay health becomes a scheduling signal and must distinguish daemon, host,
  and tunnel failures.
- WireGuard does not supply workload identity, authorization, request replay
  defense, or audit on its own; application authentication remains mandatory.
- Gateway capacity and connection draining must account for long-lived TTY/VNC
  streams across the overlay.

## Alternatives considered

- **Public host endpoints with TLS and bearer tokens.** Rejected because it exposes
  every host and turns one leaked token or firewall mistake into direct access.
- **Latitude private VLAN only.** Rejected because it is provider/topology coupled
  and may not connect the deployed gateway/control plane uniformly.
- **Tailscale or another managed overlay.** Viable later, but rejected for beta to
  avoid introducing an additional identity/control-plane dependency for the core
  data path.
- **Host-initiated reverse tunnels only.** Useful as a fallback, but rejected as
  the primary contract because multiplexing, failover, and high-bandwidth desktop
  streams would need a new tunnel control plane.

## Validation and operations

- From the public internet, scans cannot reach the `nehemiahd` listener.
- From a guest, attempts to reach the host, overlay peers, another guest, metadata,
  or private ranges fail for both IPv4 and IPv6.
- Revoking either a host application credential or its WireGuard peer prevents
  new commands; the scheduler marks it ineligible.
- An MTU and reconnect test covers REST plus sustained TTY/VNC traffic.
- The peer inventory records host ID, public key, overlay address, owner, created
  date, rotation date, and revoked date without storing private keys.
