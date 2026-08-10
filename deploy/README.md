# Nehemiah deployment

The private-beta topology has three separately deployable units:

- `apps/nehemiah`: control API, reconciliation jobs, fleet state, auth, and ledger
- `gateway`: public REST/WebSocket/preview edge with no provider credentials
- `nehemiahd`: per-host data plane reachable only over WireGuard

Build the two public images from the repository root:

```bash
docker build -f deploy/nehemiah/Dockerfile -t nehemiah-control-plane .
docker build -f deploy/gateway/Dockerfile -t nehemiah-gateway .
```

Schema and internal protocol changes use a maintenance cutover, not a rolling
deployment. The trusted deployment controller must first drain every gateway
stream, stop every prior gateway and control-plane replica, and fence their
database credentials. Only after the workflow validates the controller's exact,
bounded acknowledgement may it run migrations from the candidate control-plane
image with the runtime `DATABASE_URL` and separate owner-only
`MIGRATION_DATABASE_URL`: `npm run migrate`. Never mount the migration URL into
the long-running service. The image script executes `dist/db/migrate.js` and
`/readyz` remains red unless its expected migration is also the newest applied
schema migration.
The staging workflow performs that one-shot migration only after verifying the
exact image signature, source-bound provenance, and a maintenance acknowledgement
bound to the candidate digests and schema epoch. The acknowledgement must report
zero old control-plane replicas, zero old gateways, zero active streams, and a
database-writer fence. Its protected environment must provide
`STAGING_DATABASE_URL` and `STAGING_MIGRATION_DATABASE_URL`.
The checked-in `*-migration.env.example` files are deliberately separate from
the long-running `staging.env.example`/`production.env.example` files so an
operator cannot mount the database-owner URL by copying the runtime template.

Staging and production must use separate databases, buckets, Clerk instances,
Stripe webhook destinations, Cloudflare zones, WireGuard address spaces, and host
credentials. Promotion is manual during beta and requires `/healthz`, `/readyz`, a tenant-isolation smoke
test, one create/ready/exec/delete lifecycle, and a preview capability-token test.

The 0021+ Stripe per-invoice state, 0016+ authoritative metering cutover, 0022+
identity lifecycle, and 0023+ global stream protocol are deliberately not
compatible with prior running binaries. Never apply these migrations while an
old replica can serve or write. A failed cutover stays in maintenance and is
repaired forward with a reviewed candidate. Automatic rollback to a digest that
does not declare the database's current schema epoch is prohibited. The private
beta deployment adapter must implement `prepare_maintenance_cutover`,
`commit_maintenance_cutover`, and `hold_maintenance` exactly as validated by
`scripts/deploy/cutover-response.mjs`; until a live controller proves that
contract, deployment remains blocked.

The public services can run on any container platform with long-lived WebSocket
support. The launch deployment target remains an operator choice; deployment
automation consumes immutable image digests so choosing Fly, Kubernetes, or a
managed container service does not change the application contract.

Keep the control-plane API admission values identical across replicas. Its fixed
windows are global in PostgreSQL and fail closed in production. Before the
control-plane hop, the gateway combines a bounded process-local REST start window
with nonqueued global/source active slots, a 15-second request-body deadline, and
a 150-second whole-request deadline. `/readyz` is single-flight and cached in the
gateway for one second so concurrent public probes cannot multiply database
pings. When a public edge is present, configure only its pinned
origin CIDRs and one single-IP client header; all other forwarding headers are
ignored. The gateway signs the derived address with its service credential, so a
public caller cannot select the control-plane pre-authentication bucket.

The staging workflow scans each final digest with the checksum-pinned Trivy
binary and a freshly recorded database, rejects every HIGH/CRITICAL image or
secret finding, signs the digest with the workflow's GitHub OIDC identity, and
publishes SLSA provenance plus BuildKit SBOM attestations. The deploy job verifies
the exact workflow, source ref, and commit before calling the webhook. A production
deployment adapter must independently enforce the same signature/provenance
identity at admission; accepting an arbitrary caller-supplied digest is not a
supported deployment boundary.

Each managed host has two independent credentials: `NEHEMIAH_INTERNAL_TOKEN`
for control-plane calls to `/internal/v1/*`, and a host gateway token written as
`NEHEMIAH_TOKEN` for gateway calls to `/v1/*`. Both are unique per host and
stored encrypted by the control plane; route lookup supplies only the selected
host credential to the trusted gateway. The daemon rejects deployments that
reuse the internal token. Host releases must include signed checksums for `nehemiahd`,
`bc-guest-agent`, Firecracker, jailer, and the host-assets archive.

Managed guests receive a private NIC so the host can reach HTTP preview ports,
but nehemiahd inserts a per-tap `NEHEMIAH_FWD` drop rule before boot. Outbound
guest egress is code-enforced to `mode=off` even though the NIC and DHCP are
present. Production rollout also rejects any pre-existing nonterminal non-off
lease. Do not enable the dormant hostname/CIDR path until aggregate organization,
project, and host-network traffic quotas, connection-aware hostname enforcement,
and the active isolation suite are complete; the global hard-deny floor alone is
not an allowlist.
