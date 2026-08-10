# Public API contract and generated models

The exported OpenAPI 3.1 document in `apps/nehemiah/src/http/openapi.ts` is the
source of truth for the managed HTTP wire contract. It covers organizations,
projects, API keys, machines, fork/exec/sessions, immutable templates, volumes,
usage, Stripe receipt, fleet-operator mutations (including explicit Clerk
lifecycle synchronization), the production-disabled volume broker contract, and
the HTTP file-capability and preview-capability exchange endpoints. TTY and VNC
HTTP upgrade handshakes are included with a bounded
`x-nehemiah-websocket` extension. Their message payloads remain protocol-specific
frames rather than JSON request/response bodies. Desktop-agent and shell-agent
upgrade routes are documented as local/self-hosted-only compatibility surfaces;
managed cloud does not issue their capabilities.

Every JSON success response names an exact component schema, object schemas
choose an explicit additional-property policy, and each operation pins its
implemented status set. A route-inventory test scans all registered public
`/v1` routes and fails if the exported contract drifts. TypeScript, Python, and
Go model-only outputs live under `generated/openapi`; see its README for the
reproducible generation/check commands.

`POST /v1/operator/identity-provider/sync` accepts an exact JSON object no larger
than 16 KiB. It requires a fleet-operator owner/admin Clerk session, a safe event
ID, a positive JavaScript-safe per-target `source_version`, an immutable Clerk
subject, an explicit local organization UUID for membership events, and a bounded
operator reason. The response classifies the event as `applied`, `stale`, or
`replayed`; equal-version or event-ID payload conflicts are typed `409` responses.
Unknown local users/organizations are typed `404` responses and are never created.

`POST /v1/projects` uses the organization and slug as its canonical creation
identity. A first insert returns `201`; an exact normalized-name replay returns
the existing project with `200`; reusing the slug for a different normalized
name returns `409 project_slug_conflict`. Permanent project records are limited
to 16 per organization by default and can never exceed the private-beta hard
bound of 64. A new distinct slug at the configured limit returns
`429 project_quota_exceeded`. `GET /v1/projects` is bounded by the same retained
cardinality invariant.

## Capability safety

Cloud file methods first call `POST /v1/machines/{id}/sessions` with only the
`files` capability. The returned token is sent to the gateway only in
`Authorization: Bearer ...`. Query-token authentication, cookies, referrer
propagation, and redirects are forbidden. Gateway URLs must be bare HTTPS
origins. Uploads are byte arrays bounded to 16 MiB and a safe filename that the
host stores under `/root`; downloads require a canonical absolute guest path
and are incrementally bounded by both `Content-Length` and observed bytes.

Managed WebSocket credentials use the `nehemiah.capability.` subprotocol and
never a query. TTY and VNC handshakes pin client-frame, idle, capability, lease,
and gateway lifetime bounds. Host-local desktop and shell agents are deliberately
unsupported in managed cloud: a provider master credential is never distributed
to fleet hosts, and their process-local budget is not a tenant-attributed durable
cost control. Local/self-hosted agents receive their task after upgrade in one
text start frame within five seconds; the frame is at most 64 KiB and its trimmed
goal at most 4096 UTF-8 bytes. The old `goal` query is documented only as
deprecated local/self-hosted compatibility.

Every managed session response also returns a non-secret UUID `id`. The owning
tenant can revoke it idempotently with
`DELETE /v1/machines/{machineId}/sessions/{id}` without putting the secret token
in a URL. The gateway re-resolves the exact grant, current lease, and current
issuer authority every five seconds by default; lookup timeout is capped at five
seconds, so a live stream closes within roughly ten seconds of revocation even
when a check is already in flight. Absolute capability expiry remains an
independent hard close.

Every routed stream and preview exchange also holds a short-lived PostgreSQL
reservation against both organization and project connection/bandwidth limits.
The gateway refreshes that exact reservation during capability revalidation and
hard-closes at the returned lease expiry. Missing admission headers, a failed
lookup/refresh, or an unavailable admission service fails closed; a process-local
gateway bucket is defense in depth, not the global quota authority.

The CLI does not infer either local path. Upload rejects symlink/non-regular
sources. Download writes a same-directory mode-`0600` temporary file, flushes
it, atomically renames it, and refuses final-component symlinks and non-files.

## Deliberate limitations

Managed OCI import/pull is not implemented. Supplying `oci_reference` receives
an RFC-style `501 not_supported` response before audit intent or machine
persistence; the cloud TypeScript SDK returns `NotSupported` before transport.
The field remains documented only as a deprecated reserved field so clients do
not mistake it for a working path. Existing local/self-hosted behavior remains
unchanged.

Managed host-local LLM agents are also not implemented. Session issuance for the
`agent` capability and managed SDK/MCP helpers fail with typed `not_supported`
before any gateway or host request. Use bounded `exec`/TTY/file primitives to run
an agent whose credentials and budget are owned inside the guest. The explicit
local/self-hosted host-agent routes remain available when separately configured.

Managed volume metadata/object routes remain in the wire document only as a
deprecated, production-disabled contract. Production rejects broker configuration,
cloud SDK/MCP callers fail before transport, and the dashboard makes no object
request. Re-enablement requires aggregate count/storage/transfer quotas and
managed attach/save semantics.

The generated artifacts are wire models, not complete Python or Go HTTP
clients. Live staging evidence for the capability gateway still requires a
deployed control plane, gateway, managed host, and guest agent; repository tests
cover URL construction, credential placement, byte/time bounds, path handling,
and atomic local writes without claiming that deployment evidence.
