# Nehemiah security release checklist

This is the evidence index for the [threat model](threat-model.md), not a list of
aspirations. All boxes start unchecked. Check one only after linking evidence from
the exact release candidate and environment.

Release candidate: `________________`  
Environment/region: `________________`  
Review date: `________________`  
Security owner: `________________`  
Engineering approver: `________________`

For each checked item, record an immutable CI artifact, report, configuration
export, screenshot, query result, or reviewed change beside the item or in the
release ticket. Evidence must include artifact version/commit, environment, date,
runner/operator, expected result, actual result, and follow-up issue for any gap.

Priority meanings:

- **P0:** public-beta release blocker. Tenant isolation, host isolation, network
  deny floor, authentication, and audit integrity cannot be waived.
- **P1:** required for a supported private-beta operation or before charging unless
  a named, time-bounded risk acceptance says otherwise.
- **P2:** defense-in-depth follow-up with an owner and target date.

## Architecture and ownership

- [ ] **P0** The managed [architecture](architecture.md) and all four ADRs are
  reviewed; deployed authority, identity, connectivity, and metering match them.
  Evidence: `________________`
- [ ] **P0** A current data-flow/trust-boundary diagram includes edge, gateway,
  control plane, database, object storage, WireGuard, hosts, guests, previews,
  Clerk, Stripe, Latitude, CI, and operator access. Evidence: `________________`
- [ ] **P0** Every production service, credential, dashboard, alert, and runbook has
  a named owner and escalation path. Evidence: `________________`
- [ ] **P1** Data classification, retention, deletion, regional residency, privacy,
  abuse, and support policies are approved and customer-visible where applicable.
  Evidence: `________________`

## Tenant identity and authorization

- [ ] **P0** Clerk issuer/audience/signature/expiry validation is tested server-side;
  B.C database membership, not untrusted claims, authorizes resources. Evidence: `________________`
- [ ] **P0** B.C API keys are displayed once and the database contains only a
  non-secret prefix plus calibrated Argon2id hash. Evidence: `________________`
- [ ] **P0** API-key project restriction, scopes, expiry, disable, revoke, rotation,
  prefix collision, and constant-time verification are covered by tests. Evidence: `________________`
- [ ] **P0** Every REST, WebSocket, TTY, VNC, file, template, volume, usage, billing,
  and preview path has positive and cross-organization/project denial tests.
  Public IDs alone never authorize. Evidence: `________________`
- [ ] **P0** Browser/preview capabilities bind organization, project, current lease
  generation, audience, operation/port, and short expiry; wrong-field, replay,
  revoke, and expiry tests fail closed. Evidence: `________________`
- [ ] **P0** Host, gateway, control-plane, CI, operator, and external-provider
  credentials are distinct and cannot be used as customer credentials. Evidence: `________________`
- [ ] **P1** Human CLI login uses device/browser authorization and an OS credential
  store; no raw token is written into a project file. Evidence: `________________`
- [ ] **P1** Membership removal, user disable/delete, organization disable, and
  break-glass behavior have documented tests and audit results. Evidence: `________________`

## Public edge, API, gateway, and previews

- [ ] **P0** Cloudflare-to-origin TLS/authentication is enforced; direct origin and
  host API reachability scans fail from the public internet. Evidence: `________________`
- [ ] **P0** WAF/DDoS, unauthenticated, per-key, per-tenant, body, request-time, and
  cost-amplification limits are exported and tested. Evidence: `________________`
- [ ] **P0** The gateway never accepts a caller-supplied upstream. A control-plane
  ownership lookup selects one current host lease and registered port. Evidence: `________________`
- [ ] **P0** The SSRF suite covers host/overlay/control-plane/database/metadata,
  private/loopback/link-local/CGNAT/IPv6, encoded addresses, redirects, Host,
  absolute URLs, WebSocket upgrades, and DNS rebinding. Evidence: `________________`
- [ ] **P0** Hop-by-hop and sensitive forwarding headers are stripped; forwarded
  client/host/scheme headers are reconstructed only from trusted edge data.
  Evidence: `________________`
- [ ] **P0** WebSocket authentication occurs before upgrade; frame/message/output,
  idle, absolute lifetime, connection, and bandwidth limits work under load.
  Evidence: `________________`
- [ ] **P0** Browser cookie, CORS, CSRF, origin, CSP, wildcard preview-domain,
  referrer, and session-token policies prevent dashboard/preview origin confusion.
  Evidence: `________________`
- [ ] **P1** Gateway replicas drain long-lived streams during deploy and revoke an
  expired/disabled lease without routing to a replacement tenant. Evidence: `________________`
- [ ] **P1** Fuzzing covers public parsers, route normalization, WebSocket framing,
  guest-agent framing, and file/path inputs with actionable crash handling.
  Evidence: `________________`

## Private host identity and connectivity

- [ ] **P0** Every host has unique WireGuard and application credentials recorded
  in an owner/rotation/revocation inventory; private key material is absent.
  Evidence: `________________`
- [ ] **P0** `nehemiahd` binds only to the intended private address in managed mode;
  host firewall rules allow only designated gateway/control-plane peers.
  Evidence: `________________`
- [ ] **P0** All internal commands authenticate the peer, current host, lease
  generation, and idempotent operation; missing, revoked, wrong-host, stale-lease,
  and replay tests fail closed. Evidence: `________________`
- [ ] **P0** Internal tokens are never accepted in a URL/query string and do not
  appear in access logs, process arguments, errors, or traces. Evidence: `________________`
- [ ] **P0** Hosts have no route to peer hosts/guest ranges or direct database,
  Stripe, Clerk, or Latitude administrative access. Evidence: `________________`
- [ ] **P0** Revoking either WireGuard or application identity prevents new work;
  the scheduler marks the host ineligible and the action is audited. Evidence: `________________`
- [ ] **P1** Overlay peer redundancy, MTU, key rotation, reconnect, tunnel health,
  and sustained REST/TTY/VNC behavior are tested. Evidence: `________________`

## Firecracker and host isolation

- [ ] **P0** Managed mode makes jailer mandatory and refuses startup/placement when
  jailer, KVM, seccomp, cgroup, quota, or required firewall support is missing.
  Evidence: `________________`
- [ ] **P0** Each VM runs with a dedicated unprivileged identity, jailer chroot and
  namespaces, production Firecracker seccomp, minimal devices/files, and no host
  capabilities beyond the reviewed requirement. Evidence: `________________`
- [ ] **P0** Per-machine cgroups enforce CPU, configured memory, PID, and I/O limits;
  limit-hit behavior and cleanup are verified under hostile load. Evidence: `________________`
- [ ] **P0** Rootfs overlays and attached storage have enforced byte/inode quotas;
  exhaustion cannot consume the host root filesystem. Evidence: `________________`
- [ ] **P0** Guest-agent protocol and file paths validate lengths/types/traversal,
  bound concurrency/output/transfers, cancel on disconnect, enforce timeouts, and
  separate stdout/stderr byte-exactly. Evidence: `________________`
- [ ] **P0** Firecracker processes run in sibling systemd scopes and survive daemon
  restart; persisted lease/socket/cgroup/tap/overlay metadata reconnects without
  accepting a stale lease. Evidence: `________________`
- [ ] **P0** Startup reconciliation quarantines then deterministically removes
  unknown/orphaned process, socket, cgroup, tap, and overlay resources. Evidence: `________________`
- [ ] **P0** The exact host image, kernel, Firecracker, jailer, guest-agent, rootfs,
  and configuration versions/checksums are retained with isolation results.
  Evidence: `________________`
- [ ] **P0** A disposable Latitude host passes the isolation script and external
  penetration test with no unresolved P0/P1 guest-escape finding. Evidence: `________________`
- [ ] **P1** Serial is limited to authenticated recovery, is disabled from public
  customer paths by default, and its access/use is audited. Evidence: `________________`

## Guest network and lateral isolation

- [ ] **P0** Guest networking is off by default; enabling it requires a validated
  per-machine allowlist policy. Evidence: `________________`
- [ ] **P0** A non-overridable IPv4/IPv6 deny floor blocks loopback, unspecified,
  link-local/metadata, RFC1918, unique-local, CGNAT, multicast/broadcast, host,
  bridge, WireGuard, control-plane, database, and peer-tenant destinations.
  Evidence: `________________`
- [ ] **P0** Disposable-host probes prove a guest cannot reach host services,
  another guest, overlay peers, provider metadata, or private/internal networks
  through TCP, UDP, ICMP, raw/alternate DNS, or IPv4-mapped IPv6. Evidence: `________________`
- [ ] **P0** Hostname allowlists use intercepted DNS, validate CNAME/answers and
  each connection, clamp learned-IP TTLs, prevent rebinding, and reject an answer
  containing a forbidden destination. Evidence: `________________`
- [ ] **P0** Policy remains enforced across redirects, connection reuse, guest
  restart, snapshot/restore, fork, and daemon reconnect. Evidence: `________________`
- [ ] **P0** DNS, connection, destination, packet/byte, and egress bandwidth limits
  are enforced per machine/tenant and cannot exhaust host conntrack. Evidence: `________________`
- [ ] **P1** Firewall rules are generated atomically, survive/reconcile restart,
  remove cleanly, and expose drift/limit metrics. Evidence: `________________`

## Resource limits, lifecycle, and scheduler

- [ ] **P0** Scheduler transactions/locks prevent CPU, configured memory, and disk
  overcommit under at least 100 concurrent placement requests. Evidence: `________________`
- [ ] **P0** Memory is not overcommitted for beta; any future balloon-based policy
  is separately reviewed and stress tested before activation. Evidence: `________________`
- [ ] **P0** Hard organization/project quotas cover concurrent machines, CPU,
  memory, disk/storage, fork batch, API rate, streams, and outbound traffic.
  Evidence: `________________`
- [ ] **P0** TTL limits and reaping work after API failure and daemon restart;
  deletion, extension, fork, and create retries are idempotent. Evidence: `________________`
- [ ] **P0** Capacity exhaustion returns a stable typed 429/503 without partial
  allocation or overcommit, and releases failed reservations once. Evidence: `________________`
- [ ] **P0** Stale, unhealthy, quarantined, and draining hosts receive no placement;
  host-loss marks machines lost and releases capacity/usage exactly once.
  Evidence: `________________`
- [ ] **P0** Database outage prevents unaudited creation/authorization changes while
  bounded stop/TTL cleanup continues through a documented safe path. Evidence: `________________`
- [ ] **P1** Resource and spend anomaly alerts identify tenant/host hot spots before
  they threaten fleet availability. Evidence: `________________`

## Images, templates, volumes, and object storage

- [ ] **P0** Every machine source resolves to an immutable digest; hosts verify
  manifest/artifact digests before activation and fail closed on missing metadata.
  Evidence: `________________`
- [ ] **P0** Image/template parsers and downloads enforce type, count, expanded-size,
  path, checksum, timeout, and storage bounds; malicious archives are tested.
  Evidence: `________________`
- [ ] **P0** Host/rootfs/template images contain no production/customer credential,
  instance secret, SSH key, build token, or reusable machine identity. Evidence: `________________`
- [ ] **P0** Object access uses TLS and short-lived, operation/tenant-prefix-scoped
  credentials; hosts never possess master bucket credentials. Evidence: `________________`
- [ ] **P0** Volume/template queries and object keys are tenant-qualified;
  cross-prefix access, expired credentials, tampered objects, and delete retention
  are tested. Evidence: `________________`
- [ ] **P0** Customer durable data is encrypted at rest/in transit and backup,
  deletion, retention, lost-host, and restore semantics are documented and tested.
  Evidence: `________________`
- [ ] **P1** Image scanning, signature/provenance verification, quarantine, rollback,
  revocation, and referenced-version retention are part of promotion. Evidence: `________________`

## Secrets and privacy-safe telemetry

- [ ] **P0** Production credentials live only in the approved secret/credential
  store with least privilege, owner, creation, rotation, revoke, and access review.
  Evidence: `________________`
- [ ] **P0** Production/staging/local accounts, databases, buckets, networks,
  signing roots, and credentials are separate. Evidence: `________________`
- [ ] **P0** Repository, history, images, artifacts, logs, traces, metrics, analytics,
  errors, URLs, process arguments, environment examples, and support bundles pass
  automated secret scans. Evidence: `________________`
- [ ] **P0** Canary tests prove Authorization/cookie/query tokens, API keys, command
  bodies, terminal bytes, file contents, environment values, and customer request
  bodies are absent from default telemetry. Evidence: `________________`
- [ ] **P0** Structured telemetry uses an allowlisted schema and central redaction;
  error responses reveal no host address, local ID/path, stack, SQL, or secret.
  Evidence: `________________`
- [ ] **P1** Customer-content debugging requires explicit, time-bounded consent and
  access, records an audit event, and follows retention/deletion policy. Evidence: `________________`

## Audit, metering, and detection

- [ ] **P0** Authentication/key, membership/role, quota/billing, resource lifecycle,
  capability, host, image, deploy, admin, and break-glass actions emit complete
  audit events with actor, tenant, target, request/trace ID, outcome, and UTC time.
  Evidence: `________________`
- [ ] **P0** Normal application roles cannot update/delete audit or usage rows;
  corrections are append-only, reason-bearing, referenced, and privileged.
  Evidence: `________________`
- [ ] **P0** Usage start/checkpoint/stop and lifecycle retry replay is idempotent;
  gaps, overlaps, clock skew, resets, host loss, and late events are detected and
  quarantined rather than silently billed. Evidence: `________________`
- [ ] **P0** Host, service, and database clocks are monitored/synchronized; event
  ordering uses lease generations and monotonic counters where wall time is unsafe.
  Evidence: `________________`
- [ ] **P0** Central alerts cover auth/key anomalies, tenant denials, isolation
  failures, host health, capacity, orphan cleanup, unexpected egress, audit/usage
  lag, gateway errors/sockets, and database/object-store failures. Evidence: `________________`
- [ ] **P1** Audit access, integrity monitoring, retention, export, customer support
  lookup, and incident legal hold are tested. Evidence: `________________`
- [ ] **P1** Metering remains shadow-only until reconciliation discrepancy meets the
  approved threshold for the complete release window. Evidence: `________________`

## Supply chain, deployment, and recovery

- [ ] **P0** CI runs checks, tests, race tests, vet/lint, tenant/auth/SSRF suites,
  and shell validation from a clean immutable dependency install. Evidence: `________________`
- [ ] **P0** Release artifacts/images are checksum-pinned, signed, provenance-attested,
  scanned, promoted by reviewed automation, and fail closed when verification
  metadata is absent. Evidence: `________________`
- [ ] **P0** Production deployment requires manual approval, migration compatibility,
  health/smoke checks, and tested fail-closed forward repair or an explicitly
  schema-compatible operator rollback; it never automatically revives an
  incompatible revision. Evidence: `________________`
- [ ] **P0** Database backup/point-in-time recovery and object metadata restore are
  tested into an isolated environment with measured RPO/RTO. Evidence: `________________`
- [ ] **P0** Host-loss, capacity-exhaustion, database-outage, daemon-restart, and
  dependency-outage drills are current and all remediation items have owners.
  Evidence: `________________`
- [ ] **P0** External penetration testing covers public gateway/API/preview and
  guest-to-host/lateral isolation; no unresolved P0/P1 finding remains. Evidence: `________________`
- [ ] **P0** Incident response includes severity, on-call/escalation, containment,
  credential revoke, host quarantine/rebuild, evidence preservation, status/customer
  communications, and post-incident review. Evidence: `________________`
- [ ] **P1** Production access requires MFA, least privilege, periodic review, and
  time-bounded audited break glass; departing access is revoked promptly. Evidence: `________________`
- [ ] **P1** A current SBOM, critical advisory process, patch SLA, and emergency
  host-image rotation procedure cover the trusted computing base. Evidence: `________________`

## Final release decision

- [ ] Every P0 item above is checked with current, immutable evidence.
- [ ] No open P0/P1 isolation or cross-tenant finding exists.
- [ ] Any allowed non-isolation exception names owner, approver, expiry, customer
  impact, detection, rollback, and remediation issue.
- [ ] Security owner signs: `________________` on `________________`.
- [ ] Engineering approver signs: `________________` on `________________`.

**If any statement above is false or its evidence is stale, public beta remains
blocked.** Re-run affected evidence after changes to the host image, kernel,
Firecracker, jailer/seccomp policy, network rules, identity/authorization,
gateway routing, lifecycle/lease model, database grants, or release pipeline.
