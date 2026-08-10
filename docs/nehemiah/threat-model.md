# Nehemiah threat model

Status: release-gating baseline  
Last updated: 2026-08-08  
Scope: managed Nehemiah control plane, gateway, Latitude hosts, guests, storage,
identity, billing, and operator paths

This document states the threats and required controls for running hostile,
multi-tenant workloads. It does not assert that a control exists merely because
it is specified here. Completion is recorded with evidence in the
[security checklist](security-checklist.md).

## Security objectives

In priority order, Nehemiah must:

1. prevent a guest or tenant from accessing another tenant, the host, the control
   plane, provider metadata, internal networks, or B.C secrets;
2. ensure every action is authenticated, authorized to an organization/project,
   scoped, attributable, rate limited, and auditable;
3. keep machine placement, lifecycle, usage, and cleanup consistent under retries,
   partial failure, daemon restart, and host loss;
4. protect customer code, terminal/file contents, durable data, credentials, and
   billing data in transit, at rest, and in telemetry;
5. limit the blast radius of a compromised API key, image, guest, service, or host;
   and
6. remain safely degradable: fail closed for creation/authorization while still
   allowing bounded cleanup during dependency outages.

Availability matters, but it never overrides tenant isolation or auditability.

## Assets and data classes

| Asset                                                                       | Classification            | Required property                                           |
| --------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- |
| Customer API keys, human refresh tokens, preview capabilities               | Secret                    | Never logged; scoped, revocable, rotated                    |
| Host, database, signing, provider, Stripe, and object-store credentials     | Highly privileged secret  | Separate identities and stores; never enter a guest         |
| Customer files, terminal/exec bytes, environment values, snapshots, volumes | Customer confidential     | Tenant isolation, encryption, minimal collection            |
| Organization/project membership and billing records                         | Customer confidential     | Authorized reads; audited changes                           |
| Machine/host/lease mapping and overlay topology                             | Internal sensitive        | Not exposed to customers or guests                          |
| Images, kernels, Firecracker, guest-agent, and host releases                | Integrity critical        | Immutable digest/checksum, provenance, controlled promotion |
| Desired/observed lifecycle, audit, and usage events                         | Integrity critical        | Append-only evidence, idempotency, retention                |
| Public IDs, API schemas, status/health summaries                            | Public or low sensitivity | IDs never substitute for authorization                      |

## Trust boundaries

| Boundary                              | Data crossing it                                                      | Primary enforcement                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Internet → Cloudflare edge            | Public REST, WebSocket, preview, dashboard traffic                    | TLS, DDoS/WAF policy, request/body/rate limits                                                                                         |
| Edge → gateway/control plane          | Forwarded customer traffic and edge identity                          | Authenticated origin, strict forwarded-header policy, application auth                                                                 |
| Gateway → control plane               | Auth context, ownership/route lookups, capability issuance            | Service identity, schema validation, least privilege, audit                                                                            |
| Control plane/gateway → host overlay  | Lease-scoped machine commands and streams                             | WireGuard, peer firewall, per-host application credential, replay/idempotency checks                                                   |
| `nehemiahd`/host kernel → guest       | VMM devices, vsock guest-agent protocol, tap, disks                   | KVM/Firecracker, jailer, seccomp, namespaces, cgroups, quotas, protocol bounds                                                         |
| Guest → external network              | Private beta denies DNS and all public egress; allowlists are dormant | Code-enforced `off` policy, deny floor, and on-host isolation evidence before any future enablement                                    |
| Preview gateway → guest service       | HTTP/WebSocket for one registered machine port                        | Short-lived capability, fixed upstream mapping, header policy, lease checks                                                            |
| Control plane → PostgreSQL            | Tenant, lifecycle, audit, usage, billing state                        | TLS, scoped roles, row ownership in application, append-only grants, backups                                                           |
| Host/control plane → object storage   | Template, image, and volume objects                                   | TLS, immutable digest, tenant namespace; volume broker uses short-lived exact-key header capabilities and keeps S3 credentials private |
| Control plane → Clerk/Stripe/Latitude | Identity, aggregates/payment, fleet operations                        | Dedicated least-privilege credentials, webhook verification, egress allowlist, audit                                                   |
| Operator/CI → production              | Releases, migrations, break-glass actions                             | MFA, approval, signed artifacts, separated environments, immutable audit                                                               |

WireGuard is not treated as authorization. Crossing the private overlay still
requires a service/host identity and a current lease generation.

## Attacker models

### Malicious tenant

Has a valid account or API key and intentionally crafts IDs, races, oversized
payloads, WebSocket traffic, images, fork storms, and resource requests. May
collude across two tenants to test isolation and may know another tenant's public
resource ID.

### Compromised guest

The attacker has root inside a guest and controls its kernel-visible inputs,
network traffic, guest agent messages, filesystem, processes, and resource use.
Assume the guest is hostile from first boot.

### Leaked API key or capability

The attacker possesses a customer API key, human token, preview URL, or stream
capability from logs, browser history, source control, malware, or support data.
The attacker does not initially have the tenant's other credentials.

### Compromised host

The attacker has root on one Latitude host or controls its `nehemiahd`. Isolation
between guests on that host can no longer be guaranteed. The design must prevent
that host from impersonating another host, accessing fleet-wide secrets, changing
tenant intent, or reaching the database/provider directly beyond its narrow role.

### Malicious image

An OCI image or template intentionally attacks parsers and the guest agent,
exfiltrates at boot, lies about readiness, consumes resources, persists secrets,
or attempts a VMM/kernel escape. A compromised build pipeline can also substitute
an artifact unless digests and promotion evidence are checked.

### SSRF through previews

An attacker manipulates a preview host, port, scheme, headers, redirects, DNS, or
upgrade request so the gateway reaches a host service, metadata, control plane,
private network, another tenant, or an arbitrary public target.

### Additional credible attackers

Unauthenticated internet attackers can scan, flood, exploit parsers, steal
capabilities, or abuse signup. A compromised dependency/CI job and a malicious or
mistaken operator can alter releases, secrets, membership, quotas, or audit data.

## Threats and required mitigations

| ID  | Threat                                                                                | Required mitigations                                                                                                                                                                                                             | Primary evidence                                                             |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| T01 | Cross-tenant resource access by ID substitution, stale cache, or missing filter       | Authenticate every path; organization/project ownership predicate on every lookup; capability binds tenant, lease generation, operation/port, audience, and expiry; deny tests for REST and streams                              | Tenant isolation test matrix and gateway tests                               |
| T02 | Key/token theft, replay, overbroad scope                                              | One-time B.C keys; prefix + Argon2id hash; explicit scopes/project; expiry/revoke/rotation; no query-string auth; short-lived capabilities; rate/anomaly limits                                                                  | Storage inspection, redaction tests, revoke/expiry tests                     |
| T03 | Guest escape through Firecracker, device, kernel, jailer, agent, or filesystem bug    | Supported/pinned Firecracker and kernel; jailer mandatory; seccomp enabled; dedicated UID/GID/chroot/namespaces; minimal devices; patched releases; external penetration test                                                    | Jailer construction tests, process inspection, checksums, penetration report |
| T04 | Guest reaches host, metadata, overlay, another guest, or internal/private network     | Network off by default; non-overridable IPv4/IPv6 deny floor; per-guest namespace/tap/firewall; host input firewall; no guest route to WireGuard; metadata and lateral probes                                                    | Disposable-host isolation script and packet/firewall evidence                |
| T05 | DNS rebinding or hostname policy bypass                                               | Intercept guest DNS; validate answer and every connection; clamp learned-IP TTL; block mixed/private answers and unsupported resolvers/protocols; re-resolve safely; deny floor wins                                             | DNS rebinding, CNAME, TTL, IPv6, alternate-DNS tests                         |
| T06 | CPU, memory, PID, disk, I/O, network, fork, socket, output, or TTL exhaustion         | cgroup CPU/memory/PID/I/O limits; overlay quota; bounded process/output/file/frame sizes; connection/rate limits; transactional capacity and per-project quotas; TTL/orphan reaper                                               | Stress tests, cgroup/quota inspection, capacity drill                        |
| T07 | Malicious or substituted image/artifact                                               | Digest-pinned source; size/parser limits; verify checksum/signature before activation; immutable manifest; isolated build; scan; no baked B.C secrets; controlled promotion/rollback                                             | Manifest/provenance and tamper/failure tests                                 |
| T08 | Preview SSRF, cross-tenant routing, host-header abuse, cookie leakage                 | No caller-selected upstream; control-plane mapping to registered port/current lease; short-lived capability; strict scheme/port/header policy; hop-by-hop stripping; redirect and WebSocket validation; isolated wildcard origin | SSRF corpus, wrong-lease/port tests, route/config review                     |
| T09 | Gateway/WebSocket abuse or unauthorized long-lived access                             | Authenticate before upgrade; audience/expiry/lease checks; frame/body limits; idle/max lifetime; per-tenant connections/bandwidth; drain/revoke path; safe origin/CSRF policy for browsers                                       | Load tests, expiry/revoke during connection, protocol fuzzing                |
| T10 | Compromised host expands to fleet                                                     | Unique revocable host and WireGuard identities; host cannot authorize intent; no DB/provider/master S3 credential; short-lived object prefix access; no host-to-host route; quarantine/drain/lost procedure                      | Credential inventory, reachability tests, host-loss drill                    |
| T11 | MITM, spoofed host, replayed internal command                                         | WireGuard plus application authentication; current lease generation; operation ID/idempotency; time/nonce or signature replay bounds; rotation and revocation                                                                    | Internal API auth/replay tests and peer audit                                |
| T12 | Lifecycle race leaves orphan, double allocation, wrong route, or double bill          | Commit intent/reservation before side effect; transactional locks; stable lease generation; host atomic state; sibling systemd scope; reconciler; terminal monotonicity; idempotent release/ledger                               | Concurrency, daemon-restart, timeout, orphan, and host-loss tests            |
| T13 | Secret/customer-content leakage in logs, traces, errors, support bundles, crash dumps | Allowlisted structured fields; central redaction; never capture auth/query tokens, command/terminal/file/env/body by default; access/retention controls; secret scanning; safe errors                                            | Canary-secret end-to-end test and telemetry schema review                    |
| T14 | Database/object-store compromise or tenant-prefix confusion                           | TLS/encryption; scoped service roles; separate environments; tenant-qualified queries/keys; append-only grants; backups/restore; volume capabilities short-lived and bound to one reservation-derived key                        | Role/grant review, cross-key tests, restore drill                            |
| T15 | Forged Clerk/Stripe/provider webhook or privileged request                            | Verify issuer, audience, signature, timestamp, and replay ID; least-privilege outbound clients; idempotent handlers; audit; no runtime dependency on Stripe                                                                      | Invalid/replay fixture tests and credential-scope review                     |
| T16 | Supply-chain or operator compromise                                                   | Protected reviewed changes; pinned dependencies/artifacts; checksums/signatures/provenance; isolated CI identity; manual production approval; MFA; time-limited audited break glass                                              | CI/release attestation, access review, rollback exercise                     |
| T17 | Public denial of service or cost amplification                                        | Cloudflare DDoS/WAF; unauthenticated and tenant rate limits; body/frame/time bounds; bounded queues; quotas/spend caps; backpressure; capacity responses that do not overcommit                                                  | Edge configuration export and REST/WebSocket load tests                      |

## Mandatory isolation policy

Managed mode must fail startup or refuse placement when a required isolation
primitive is unavailable. Degraded isolation is not a capacity fallback.

### Host and process isolation

- Firecracker runs through jailer under a per-machine unprivileged identity and
  chroot/namespace boundary with its production seccomp filter enabled.
- CPU, configured memory, PIDs, and I/O are constrained in the machine's cgroup.
  Overlay and durable-disk attachment sizes have enforced quotas.
- Firecracker lives in a sibling systemd scope so a daemon restart can reconnect
  without killing a tenant VM. Scope, socket, cgroup, tap, overlay, and lease
  metadata are reconciled atomically; unknown resources are quarantined and reaped.
- Guest-agent messages, file paths, lengths, exit data, PTY frames, and concurrency
  are treated as hostile. Output, upload/download, process count, and timeouts are bounded.
- Host services use dedicated identities. KVM, image, kernel, and Firecracker
  version/checksum evidence is recorded with each host-image release.

### Guest network isolation

Networking starts disabled. An approved policy can only narrow the platform's
hard deny floor; neither a tenant nor operator override may permit:

- IPv4/IPv6 loopback and unspecified addresses;
- link-local and cloud/provider metadata destinations;
- RFC1918 private, IPv6 unique-local, and carrier-grade NAT ranges;
- host bridges/interfaces, WireGuard overlay, control-plane/database/provider
  networks, or any peer-tenant guest range; or
- multicast/broadcast and routes/protocols that bypass the enforced DNS/egress path.

Rules apply after DNS resolution, on connection, and across redirects. IPv4-mapped
IPv6, CNAME chains, rebinding, alternate DNS, raw sockets where applicable, and
fragmentation are included in tests. Egress has DNS, connection, packet/byte, and
destination limits. Ingress reaches only a registered port through the gateway.

## Identity, secrets, and audit requirements

Credentials are separated by customer, host, service, environment, and external
provider. Production secrets live in an approved secret manager or OS credential
store, are delivered only to the process that needs them, have an owner and
rotation/revoke procedure, and are absent from images, repositories, environment
examples, shell history, URLs, telemetry, and guest-visible metadata.

The append-only audit stream records at least:

- login/key create, scope change, use metadata, revoke, and authentication failures;
- organization membership/role, project, quota, billing, and administrative changes;
- machine/template/volume lifecycle intent and result;
- host register, credential rotate/revoke, heartbeat state, drain, quarantine,
  image promotion, deployment, and break-glass actions; and
- preview/stream capability issuance and authorization denial without recording
  customer payload or terminal/file contents.

Events carry UTC time, actor/service identity, organization/project, action,
target, request/trace ID, outcome, reason/error class, and before/after references
where safe. Audit and usage tables deny update/delete to normal application roles.
Clock synchronization, retention, access, export, and integrity monitoring are
operational controls, not deferred documentation details.

## Compromise containment

- **Leaked customer key:** revoke by prefix, terminate or expire issued
  capabilities, inspect audit/use metadata, rotate, and keep quotas/rate limits in force.
- **Compromised guest:** stop its lease, preserve only approved forensic metadata,
  quarantine its image/volume as policy permits, and inspect host isolation signals.
- **Compromised host:** revoke host and WireGuard credentials, remove placement,
  mark its machines lost, rotate any scoped object credentials, rebuild rather than
  return it to service, and investigate adjacent control-plane events.
- **Compromised control-plane credential:** revoke/rotate the individual identity,
  stop privileged jobs, preserve append-only evidence/backups, and assume affected
  tenant metadata requires incident review.

Detailed execution belongs in incident and failure runbooks. Customer notification
and evidence retention follow the incident policy and applicable legal obligations.

## Assumptions and residual risks

- KVM, the supported host kernel, Firecracker, and its jailer/seccomp boundary are
  trusted computing base. Zero escape risk is not claimed.
- Root compromise of a host exposes confidentiality/integrity of guests currently
  on that host. The design limits fleet-wide credentials and makes those machines
  honestly `lost`; it does not promise confidential computing.
- Ephemeral machine state is lost with an unrecoverable host. Only declared durable
  volume data has persistence semantics.
- Cloudflare, Clerk, Neon/PostgreSQL, object storage, Stripe, and Latitude remain
  supply-chain/availability dependencies. Least privilege and graceful degradation
  reduce but do not remove this risk.
- Customer-approved public egress can exfiltrate data already available inside
  that customer's guest. Nehemiah prevents platform/private destinations; it does
  not classify the customer's own data.

## Verification and release gate

Threat mitigations require repeatable evidence from the same artifact and
environment intended for release. Unit tests alone are insufficient for kernel,
firewall, jailer, public-edge, and cross-host controls.

At minimum retain:

- CI tenant, auth, concurrency, idempotency, SSRF, restart, and reconciliation output;
- the disposable-host isolation report for the exact host image, kernel, and
  Firecracker checksums;
- public/private reachability scans and guest IPv4/IPv6 lateral/metadata probes;
- database/object-store role reviews and backup/restore results;
- canary-secret telemetry/redaction results;
- load, capacity, database-outage, daemon-restart, and host-loss drill reports; and
- external penetration-test findings, remediation, and accepted residual risks.

**Public beta is blocked until every P0 item in the security checklist has a named
owner, dated evidence for the release candidate, and no unresolved failing result.**
An unchecked box, TODO, verbal confirmation, stale artifact, or undocumented risk
acceptance is not evidence. Exceptions require a written, time-bounded owner and
remediation date, and an exception cannot waive tenant isolation, host isolation,
the hard network-deny floor, authentication, or audit integrity.

Review this model after any trust-boundary change, new machine device, new provider
or region, security incident, critical dependency advisory, or at least quarterly
during beta.
