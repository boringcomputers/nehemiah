# Nehemiah implementation status

Status: engineering implementation snapshot, **not** a launch approval  
As of: 2026-08-09  
Plan: [Nehemiah implementation plan](../../.hermes/plans/2026-08-08_204915-nehemiah.md)

## Bottom line

The repository contains the core managed-cloud control plane, host data plane,
gateway, clients, dashboard, deployment definitions, and release machinery. Those
paths have local automated coverage, including real PostgreSQL integration tests
and race-tested Go packages. This is useful implementation evidence, but it is not
evidence that a deployed Nehemiah cloud works on the intended production
dependencies.

Phase 9 has not been completed. There is no recorded three-host Latitude staging
cohort, completed Bezalel/Ruth dogfood run, activated SLO baseline, or approved
private-beta gate. Nothing in this document should be read as a claim that private
beta or public beta is ready, open, or live.

In this document, **locally verified** means that the behavior is represented by
automated unit, integration, race, build, or static checks in this repository and
was exercised during implementation. It does not substitute for rerunning the
complete CI matrix on an immutable release candidate, and it does not validate an
external provider.

## Implemented and locally verified

| Area                                            | Implemented scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Local evidence boundary                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and security contracts             | Control/data-plane ownership, lifecycle and idempotency rules, tenant boundaries, host-network decision, threat model, security checklist, SLO proposal, and operational runbooks                                                                                                                                                                                                                                                                                                       | Documentation and invariant tests describe the intended boundary; the security checklist still requires deployed evidence                                                                                                                                                                                                    |
| Control-plane foundation                        | TypeScript control plane, checksummed PostgreSQL migrations, separate runtime/migration roles, health/readiness, organizations, projects, memberships/RBAC, scoped Argon2id API keys, device authorization, audit records, and encrypted per-host credentials                                                                                                                                                                                                                           | Type checks, unit tests, migration replay/checksum tests, tenant tests, and fresh-PostgreSQL integration tests exercise these paths                                                                                                                                                                                          |
| Admission, scheduling, and lifecycle            | Pre- and post-auth distributed admission limits, project/organization quota enforcement, deterministic placement and reservations, idempotent create/delete/extend/fork, batch-fork cleanup, TTL reaping, heartbeat/draining/lost-host reconciliation, and billing/spend admission                                                                                                                                                                                                      | Concurrency and failure-path tests use local PostgreSQL and fake host/provider clients; they do not prove behavior under real provider or network failure                                                                                                                                                                    |
| Authoritative metering and billing              | Host monotonic runtime observations, cumulative egress high-water observations, durable host outbox and acknowledgements, control-plane receipt/quarantine logic, append-only usage/audit ledgers, aggregation, ordered per-invoice Stripe webhook handling, delinquency, and zero-rate shadow spend admission                                                                                                                                                                          | Go tests and PostgreSQL integration tests cover replay, gaps, conflicts, exact integer accounting, and admission behavior; outbound Stripe aggregate reporting, storage accrual, nonzero rates, customer charging, and live reconciliation are not implemented/evidenced                                                     |
| Host data plane                                 | Authenticated internal API, capacity/heartbeat state, persisted lease/runtime state, orphan handling, sibling systemd scopes, jailer/cgroup limits, restart reconciliation, template cache/transfer, machine lifecycle, exec/files/TTY/VNC, readiness, single fork, and all-or-cleanup batch fork                                                                                                                                                                                       | `nehemiahd` unit/race tests use fake or local process/network fixtures; compile checks cover Linux amd64 and arm64, but physical KVM and native arm64 execution are external gates                                                                                                                                           |
| Guest agent                                     | Framed vsock protocol, separate bounded stdout/stderr, cancellation, readiness, file transfer, PTY, and liveness/reconnect behavior                                                                                                                                                                                                                                                                                                                                                     | Guest-agent unit/race tests verify framing, byte bounds, cancellation, and PTY semantics without claiming an end-to-end production guest boot                                                                                                                                                                                |
| Managed network policy                          | Network-off default, reviewed public IPv4 CIDR allowlists, hard private/metadata/overlay deny floor, per-tap source binding, forged-source rejection, DNS interception, connection/packet/bandwidth ceilings, and fail-closed cleanup                                                                                                                                                                                                                                                   | Network and policy tests validate rule generation and simulated isolation; the Latitude/WireGuard/guest-kernel path still needs on-host verification                                                                                                                                                                         |
| Public gateway and previews                     | REST and WebSocket proxying, tenant/lease/port-bound short-lived capabilities, per-client edge limits, PostgreSQL-authoritative organization/project stream and bandwidth reservations, bounded streams, control-plane TLS verification, graceful HTTP/WebSocket drain, SSRF defenses, and wildcard preview fragment exchange into an origin-scoped HttpOnly cookie                                                                                                                     | Gateway race tests and route/security tests cover credential placement, global reservation/refresh/expiry, routing, bounds, drain, and rejection cases; no Cloudflare or live managed-host path is evidenced                                                                                                                 |
| Templates and volume objects                    | Immutable template metadata/visibility plus production-disabled template and volume-transfer pipelines; the dormant volume broker has exact-key, byte-bounded test coverage                                                                                                                                                                                                                                                                                                             | Unit and PostgreSQL tests cover tenant isolation, reservations, checksums, streaming bounds, replay, and deletion scheduling; neither managed custom publication nor managed volume storage is enabled in production                                                                                                         |
| Public contract and clients                     | OpenAPI 3.1 route inventory, deterministic TypeScript/Python/Go wire models, full TypeScript SDK for local/self-hosted/cloud targets, CLI with device login and OS credential storage, MCP tools, `Nehemiahfile`, and typed target-specific errors                                                                                                                                                                                                                                      | Contract drift, schema-reference, TypeScript SDK/CLI, MCP, and generated-model compile checks are present; Python and Go are not full clients                                                                                                                                                                                |
| Dashboard and public pages                      | Authenticated organization/project, machine, template, volume, usage, and API-key views; device approval; public status and support pages with bounded, sanitized server-side integrations                                                                                                                                                                                                                                                                                              | Web unit/browser tests, type checks, lint, and production build exercise local behavior; no live Clerk session, status origin, support destination, or accessibility sign-off is evidenced                                                                                                                                   |
| Deployment, telemetry, and release supply chain | Container builds, environment validation, fail-closed production configuration, database role split, schema/protocol maintenance-cutover contract, OTel instrumentation, collector config, alerts and dashboards, staging admission policy, staging-evidence-bound manual production promotion, manual Latitude provisioning, deterministic signed/checksummed release inputs, guest-image scan evidence, Homebrew formula generation, and retained Firecracker/jailer/kernel artifacts | Structural validators, synthetic promotion evidence tests, shell tests, release determinism/checksum tests, vulnerability checks, and offline provisioning tests cover repository artifacts; GitHub protection settings, the external deployment controller, protected release, and live deployment evidence remain external |
| Staging and failure harnesses                   | Smoke, tenant-isolation, host-loss, billing-reconciliation, and REST/WebSocket load harnesses plus restart, database, capacity, and host-loss runbooks                                                                                                                                                                                                                                                                                                                                  | Harness syntax and local helpers are checked. A harness existing in the tree is not evidence that it has passed against staging                                                                                                                                                                                              |

## Explicitly unsupported or deliberately disabled

These are product boundaries, not hidden partial support:

- **Managed custom-template publication:** production configuration rejects
  enabling the publisher/replication worker, the TypeScript SDK and CLI fail
  locally without a request, and the dashboard does not offer the action. The
  dormant transfer implementation cannot be enabled until aggregate tenant and
  host-cache quotas, billing admission, and durable object/replica eviction are
  enforced and tested. Built-in templates remain supported.
- **Managed OCI machine sources:** the managed API returns typed
  `501 not_supported`, and the TypeScript SDK fails with `NotSupported` before
  transport. Release-bound built-ins and existing reviewed immutable records
  provisioned by an operator are the supported cloud sources.
- **Managed volumes:** the production control plane rejects broker enablement,
  cloud SDK/MCP clients fail locally, and the dashboard presents the disabled
  boundary. The dormant metadata/object implementation cannot be enabled until
  durable volume and revision-count quotas, bounded revision compaction, global
  transfer admission, and machine attach/save are enforced and tested.
- **Managed host-local LLM agents:** the cloud control plane does not issue
  desktop-agent or shell-agent capabilities, and managed clients fail locally.
  Fleet bootstrap deliberately carries no provider master model credential, and
  the host's process-local run counter is not a tenant-attributed durable budget.
  Local/self-hosted agents remain available when an operator explicitly configures
  them; managed callers can run their own agent inside the guest through bounded
  exec, TTY, and file primitives.
- **Complete Python and Go SDKs:** deterministic Python and Go wire models are
  generated and compiled, but there are no transport clients or ergonomic
  `Machine` wrappers for those languages. The TypeScript SDK is the complete
  client implementation.
- **Harbor and Dagger adapters:** neither ecosystem integration is implemented.
  They remain post-core work after the public contract is stable.
- **Managed guest egress:** production and private-beta control-plane admission is
  code-enforced to `mode=off`. Hostname, IPv4 CIDR, and IPv6 rules remain dormant
  until hard organization, project, and host-network traffic quotas exist; a
  connection-aware proxy must also bind every hostname-authorized connection.
- **Memory overcommit:** configured guest memory is reserved in full. Balloon and
  resident-memory telemetry do not authorize scheduling overcommit without a
  measured hardware policy.
- **Automatic bare-metal scaling:** the launch path is a manually approved,
  statically provisioned Latitude fleet. Provider adapters and provisioning
  scripts do not constitute an automatic capacity controller.
- **Charging and outbound Stripe usage reporting:** private-beta rate-card values
  are deliberately zero, so spending caps are shadow-only while hard resource
  quotas carry risk control. The control plane verifies and source-orders inbound
  Stripe invoice webhooks, but it does not yet accrue durable-volume storage or
  export deterministic aggregate usage to Stripe. Nonzero rates and charging
  remain disabled until those projections, retries, reconciliation, finance
  policy, and the metering shadow gates are complete.

## External launch evidence still required

The following must be produced against an immutable candidate build and retained
with environment, timestamp, operator, and result. Mocked or local test results do
not close these gates.

### Latitude, KVM, and host artifacts

- Provision approved Latitude servers through the real API and record inventory,
  plan/site/OS-image identity, user-data deletion behavior, and host enrollment.
- On physical hardware, prove `/dev/kvm`, Firecracker+jailer startup, cgroups,
  tap/iptables or nftables rules, overlay quotas, guest-agent vsock, and cleanup.
- Boot both signed `python` and `desktop` guest artifacts and verify their declared
  runtimes, readiness, exec, PTY, VNC, files, and restart continuity.
- Run the release build on a native arm64 runner and boot the resulting arm64 host
  and guest artifacts on arm64 KVM hardware. Cross-compilation alone is not this
  evidence.
- Demonstrate that a fresh install and rollback consume only retained,
  signed/checksummed release assets, with no dependency on an upstream
  Firecracker, jailer, kernel, package, or OCI URL remaining available.

### Three-host private network and failure behavior

- Bring up at least three hosts in one region over the intended WireGuard overlay
  and prove that host APIs are not customer-public and guest networks cannot route
  to the overlay, metadata, private ranges, the host, or peer tenants.
- Run cross-tenant and forged-source checks, prove the managed `off` policy
  rejects CIDR/DNS egress and rebinding attempts, and exercise preview SSRF and
  registered-port isolation from real guests.
- Execute controlled daemon restart, drain, host isolation/loss, full-capacity,
  database-outage, gateway-deploy/WebSocket-drain, and orphan-cleanup drills while
  workloads are active. Confirm honest terminal state, placement elsewhere,
  exact-once reservation/usage results, and no residual VMM, scope, socket,
  cgroup, tap, overlay, or capability.

### External services

- **S3-compatible storage (future enablement only):** it is not a private-beta
  launch dependency while managed template transfer and volume storage remain
  disabled. Before enabling either feature, prove exact conditional writes,
  native full SHA-256, reported SSE mode, streaming bounds, versioned deletion,
  replication, and recovery against the selected provider.
- **Cloudflare:** prove wildcard DNS/TLS, origin isolation, forwarded-client
  identity, WAF/rate policy, preview fragment exchange, cookie scope, SSRF
  rejection, and WebSocket behavior through the real edge.
- **Clerk:** prove dashboard sign-in/session validation, organization membership
  changes, device approval, expiry/revocation, and environment separation with a
  real Clerk instance.
- **Stripe:** prove webhook signature handling, retries, shadow meter export,
  invoice reconciliation, delinquency, and spending-cap admission in a separated
  test account before enabling any real charge.
- **OTLP/operations:** prove all three services export to the deployed collector,
  dashboards show the documented denominators, canary-secret tests stay clean,
  alerts page the intended destination, and logs/traces contain identifiers but
  not credentials or customer content.
- Prove the public status probes and support delivery path with their real origins
  and destinations without exposing internal topology or submitted secrets.

### Product and release gates

- Exercise the [production promotion runbook](runbooks/production-promotion.md)
  through the protected GitHub `production` environment with a successful
  completed staging run for the exact reviewed protected-`main` SHA. Retain the
  bounded promotion artifact/attestation, image signature/provenance results,
  cutover ID, schema epoch, health/smoke results, reviewer, and forward-repair
  outcome for any failure.
- Exercise the real deployment controller's maintenance-cutover contract: drain
  all streams, stop every old gateway/control-plane replica, fence old database
  writers, apply the exact candidate schema, start only the digest-bound candidate,
  and prove a failed gate remains fenced for forward repair instead of reviving an
  incompatible image.
- Run the smoke, tenant-isolation, billing-reconciliation, host-loss, and load
  harnesses against the actual staging URL with independently issued tenant
  credentials.
- Complete the Bezalel and Ruth dogfood matrix, including fork/batch-fork,
  browser/desktop, preview, cancellation, TTL cleanup, and an honest record of
  every failed or timed-out sample.
- Collect representative Latitude baselines for cold boot, restore, first exec,
  fork, TTY/VNC, preview, disk, managed egress-off enforcement, cleanup, and
  orphan rate. Fill the `TBD` thresholds in the SLO document and observe the
  candidate long enough to validate its denominators and error budgets.
- Run authoritative metering in shadow mode, compare runtime/configuration/egress
  high-water values with independent host observations, rebuild aggregates, and
  approve the discrepancy window before billing anyone.
- Exercise the protected GitHub release environment: verified signed tag,
  immutable release setting, native architecture builds, vulnerability evidence,
  OIDC provenance, checksum/Minisign verification, and consumer install/rollback.
- Close every P0/P1 item in the security checklist with linked evidence and obtain
  the required operator/security approvals.

## Release-candidate revalidation

Local implementation results are intentionally not a permanent green badge. The
exact candidate commit must pass the repository CI matrix again, including:

- workspace type-check, lint, test, build, dependency audit, and the complete
  control-plane suite against a fresh PostgreSQL database with migration replay;
- `go test -race`, `go vet`, vulnerability checks, and Linux amd64/arm64 builds for
  `nehemiahd`, the guest agent, and the gateway;
- OpenAPI route/schema drift checks and TypeScript/Python/Go model compilation;
- shell checks, managed provisioning tests, observability validation, staging
  image-admission checks, release determinism, exact artifact-set verification,
  vulnerability scan policy, signatures, checksums, and provenance checks; and
- the live staging harnesses listed above, which CI cannot replace with fakes.

Only after both the candidate-wide local/CI matrix and the external evidence are
complete can the private-beta acceptance criteria be evaluated. Public beta is a
later decision requiring sustained SLO, security, support, capacity, and billing
evidence; it is not implied by completing the private-beta implementation.
