# ADR 0003: Clerk users and B.C-issued API keys

- Status: accepted
- Date: 2026-08-08

## Context

Nehemiah has two distinct authentication paths. Humans use the dashboard and
need session, login, and account-recovery flows. SDK, CLI automation, MCP servers,
and CI need stable, revocable, least-privilege credentials. Treating a machine ID
or preview URL as a secret is insufficient, and distributing a shared host token
would bypass tenant authorization.

Authentication proves an actor. Authorization must still be evaluated against
B.C-owned organization, project, resource, and scope records.

## Decision

Use Clerk to authenticate human dashboard users. Use B.C-issued API keys for
programmatic access.

### Human sessions

- The web application validates Clerk tokens server-side and maps the immutable
  Clerk subject to an internal user.
- B.C PostgreSQL records are authoritative for organization membership, project
  access, roles, quotas, and resource ownership. Clerk claims alone do not grant
  access to a B.C resource.
- Sensitive operations require a fresh session as appropriate and always emit an
  audit event.
- The CLI may use a browser/device authorization flow and silent refresh for a
  human. Refresh material is stored in an OS credential store, never in a project
  file, is bound to the exact canonical issuer origin, and is not interchangeable
  with an API key.
- PostgreSQL serializes fixed, non-configurable global retained-row ceilings:
  50,000 device authorization rows, 4,096 refresh-family rows, 1,048,576 refresh
  generations, and 1,048,576 access generations. A singleton cleanup job deletes
  terminal access generations and family-free codes after a one-hour evidence
  window, then deletes an entire expired or revoked refresh chain together after
  24 hours. It never deletes live authority or audit events; a capacity rejection
  is a typed retryable denial and never creates one new append-only audit row per
  rejected request.

### Provider lifecycle synchronization

- Clerk lifecycle state enters B.C only through the explicit authenticated
  `POST /v1/operator/identity-provider/sync` fleet-operator endpoint. The control
  plane does not depend on a public provider webhook.
- The endpoint maps an immutable Clerk subject only to an existing local user and
  accepts membership changes only for an explicit existing local organization
  UUID. It never creates a user or organization and never lets provider data
  enable a locally disabled identity.
- Each user or user/organization stream carries a positive integer source version.
  Append-only receipts store bounded identifiers and a canonical SHA-256 digest,
  never the provider credential or raw payload. Same-payload replay and older
  events are idempotent; an event-ID or source-version collision fails closed.
- User deletion and disable both set the reversible B.C-owned disabled state.
  Membership removal uses the database revocation cascade; role downgrade changes
  current authorization immediately. Every applied, stale, replayed, conflict,
  invalid, unknown-target, and authorization-denied outcome is audited.
- Fleet-operator user, organization, membership role, and provider authorization
  are revalidated and locked inside the same transaction as ordering and mutation.

### Programmatic keys

- Keys use a recognizable `bc_...` secret format. The complete secret is shown
  exactly once.
- The database stores a non-secret lookup prefix and an Argon2id hash, never the
  complete key or a reversible ciphertext.
- A key belongs to one organization and is optionally narrowed to one project.
  It has explicit scopes: `machines:read`, `machines:write`, `templates:read`,
  `templates:write`, and `billing:read`.
- Authentication is constant-time after prefix lookup. Disabled, expired,
  revoked, or organization-disabled keys fail closed.
- Creation, use metadata, scope changes, and revocation are audited. Logs may
  contain the non-secret prefix, but never the credential or Authorization header.
- Rotation creates a new key and then revokes the old key; a raw secret cannot be
  recovered. Administrative overrides are time-bounded and audited.

Short-lived, signed, capability-scoped tokens are used for browser streams and
previews. They name an organization/project, machine lease generation, operation
or port, audience, and expiry. They are not general API credentials and are
revalidated at the gateway. Host credentials, service credentials, provider
credentials, and customer credentials are separate classes and cannot substitute
for one another.

Every authorization query includes the authenticated organization/project
boundary. Globally unique resource IDs improve routing and support, but possession
of an ID never grants access.

## Consequences

### Positive

- Clerk handles human authentication complexity without controlling Nehemiah's
  resource authorization model.
- Automation gets revocable, scoped credentials with no recoverable secret at rest.
- Preview and WebSocket links have short-lived, narrow authority.
- A leaked credential's blast radius is bounded by tenant, project, scopes, expiry,
  quotas, and rate limits.

### Costs and constraints

- Identity-provider delivery tooling must call the explicit fleet-operator sync
  endpoint with a durable per-target source version.
- API key verification needs calibrated Argon2id parameters, abuse rate limits,
  prefix collision handling, and a rotation process.
- Dashboard, API key, capability, host, and service authentication paths require
  independent tests and telemetry.
- Clerk unavailability may block new human sessions but must not invalidate
  already authorized API-key automation or alter machine cleanup.

## Alternatives considered

- **Clerk-managed API keys and organizations as the sole authority.** Rejected
  because programmatic scopes, project ownership, audit, and runtime authorization
  must remain consistent with B.C database transactions.
- **One shared tenant bearer token.** Rejected because it cannot express project
  scope, rotation, attribution, or least privilege.
- **JWTs as long-lived API keys.** Rejected because immediate revocation and secure
  rotation become harder and claims become stale.
- **Machine IDs or preview URLs as secrets.** Rejected because they leak through
  logs, history, referrers, and support workflows and provide no actor identity.

## Validation

- Cross-organization and cross-project tests cover every resource route and stream.
- Tests prove the raw API key is absent from database rows, logs, traces, errors,
  analytics, and audit payloads.
- Scope, expiry, revocation, membership removal, and organization-disable tests
  fail closed.
- Fresh-PostgreSQL tests prove device retained-row admission is serialized across
  replicas, self-referential refresh chains are deleted atomically, cleanup
  failure rolls back, active access remains valid, and runtime code cannot mutate
  the capacity counters directly.
- Fresh-PostgreSQL tests cover provider replay, stale and conflicting ordering,
  subject immutability, unknown targets, membership downgrade/removal cascades,
  and operator-removal races.
- Preview tokens fail for the wrong machine generation, port, audience, tenant,
  or expiry and cannot call the REST API.
