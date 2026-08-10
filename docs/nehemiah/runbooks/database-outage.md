# Runbook: PostgreSQL outage

Use this runbook when the Nehemiah primary database is unreachable, read-only,
timing out, exhausted, returning integrity errors, or suspected corrupt. PostgreSQL
is the source of truth for tenant authorization, intent, placement, leases,
idempotency, audit, and usage. Nehemiah fails closed rather than create an
unaudited split brain.

## Safe degraded behavior

During an untrusted database state:

- reject new create, fork, extend, template/volume mutation, key/membership/quota,
  billing, and other authorization-changing requests with a typed temporary error;
- do not place a machine, reserve capacity, mint a new route/preview capability,
  or authorize from an unbounded/stale cache;
- public deletes/stops that require a fresh ownership decision also fail closed;
- already established streams or short-lived capabilities may continue only until
  their existing expiry if the gateway needs no new authority and revocation risk
  is accepted by the pre-defined policy;
- `nehemiahd` continues enforcing existing lease TTLs, local stop intent already
  durably received, resource limits, and orphan cleanup, buffering bounded signed
  observations for idempotent ingestion after recovery; and
- Stripe reporting retries asynchronously. Billing unavailability never blocks host cleanup.

If it is unclear whether an operation was committed before the outage, retry only
through its original idempotency key after database authority returns. Never issue
a second direct host command.

## Detect and declare

Open an incident on failed readiness, connection-pool exhaustion, sustained query
timeout/error, replica/primary divergence, failed migration, provider database
alert, unexpected read-only state, disk/WAL saturation, or audit/usage ingestion stall.

Record UTC start, environment, database cluster/branch identifier, application
build/migration version, affected endpoints/jobs, error classes and request IDs,
last known good transaction/backup/watermark, provider status, and SLO impact.
Do not paste DSNs, SQL parameters containing customer data, credentials, or raw rows.

## Immediate containment

1. Page database and incident owners. Put control-plane readiness into the
   documented fail-closed state and verify every API/scheduler worker stops new mutations.
2. Confirm gateway route/capability cache TTLs remain bounded and no fallback
   converts a cached host mapping into fresh authorization.
3. Confirm hosts continue existing TTL/resource enforcement and receive no
   unaudited creates. Protect local observation buffers from unbounded growth.
4. Pause migrations, deploys, backfills, projector rebuilds, and high-volume
   nonessential jobs. Do not repeatedly restart all application instances.
5. Check whether the failure is connectivity/DNS/TLS, credentials, pool/saturation,
   lock/query, migration/schema, provider/storage, replica, or data-integrity related.
6. Publish customer/status impact and next update time if material. Existing
   machines may run until their lease/host state changes; do not promise mutations.

## Diagnose without making a split brain

Use provider and database observability through approved read-only access:

- primary role, timeline/branch, health, storage/WAL, connection and transaction counts;
- application pool saturation, acquisition wait, statement timeout, and retry storm;
- top wait classes/locks and newly deployed query/job/migration;
- network/DNS/TLS reachability from each control-plane environment;
- replica lag/read-only status and backup/PITR availability; and
- append-only audit/usage and machine-event watermarks.

Do not promote a stale replica, run manual writes, terminate transactions, change
schema, restore, or fail over until the incident/database owner understands the
RPO/RTO and consistency effect. A provider's green status is not proof that the
application schema, credentials, or connectivity is healthy.

### Common cases

| Failure | Safe response |
| --- | --- |
| Connection storm/pool exhaustion | Stop nonessential jobs, bound API retry/backoff, reduce per-instance pool to approved total, identify leak/slow transaction |
| Blocking migration/query | Keep mutations disabled; cancel/rollback only through approved database procedure; validate schema compatibility |
| Expired/revoked credential | Rotate the one service identity through secret manager; do not share an admin DSN |
| Network/DNS/TLS path | Restore the approved private/secure path; do not open the database publicly or disable verification |
| Provider primary failure | Use documented provider failover with verified recovery point and one writer |
| Suspected corruption/operator error | Freeze writes, preserve evidence, choose PITR point, restore into isolation first |

## Restore service

Recovery is staged; do not enable create immediately when one health check turns green.

1. Verify one authoritative writable primary, expected timeline/schema/migration
   version, TLS/credential path, and stable storage/connection/lock health.
2. Run read-only integrity and migration compatibility checks. If restoring/PITR,
   compare the chosen recovery point with last known lifecycle/audit/usage watermarks.
3. Start one bounded control-plane worker cohort. Keep customer mutations and
   placement disabled while health/read paths and idempotency records are checked.
4. Ingest buffered, authenticated host observations idempotently. Quarantine stale
   lease generation, counter regression, overlap, and gap rather than guessing.
5. Reconcile desired state, host current leases, reservations, lifecycle events,
   TTL/stop observations, audit, usage high-water marks, and gateway routes for all
   operations spanning the outage.
6. Verify no duplicate machine, fork child, extension, reservation, capacity
   release, audit mutation, or usage interval exists. Run focused tenant-isolation
   and create-timeout tests.
7. Resume cleanup/reconciliation jobs, then read APIs, then a canary create/ready/
   exec/stop in a non-customer project. Expand worker traffic gradually.
8. Re-enable customer mutations/placement only after database and incident owners
   approve. Resume projectors/backfills/Stripe last with bounded load.

If the database was restored behind the last acknowledged control-plane commit,
do not recreate missing intent from host state alone. Treat host runtimes as
quarantined observations, resolve through incident policy, and communicate any
data-loss boundary honestly.

## Recovery checks

- [ ] One authoritative primary and expected schema/timeline are verified.
- [ ] No service bypasses database authorization or writes to an old primary/branch.
- [ ] Hosts received no new unaudited creates during the outage.
- [ ] Buffered host events are ingested with no silent drop, overlap, or duplicate.
- [ ] Machine, lease, reservation, audit, usage, route, and host state reconcile.
- [ ] API/create/gateway SLIs and database saturation are stable after gradual reopen.
- [ ] Customer/status communication states the actual data and operation impact.
- [ ] Root cause, RPO/RTO, detection, fail-closed validation, and remediation owners are recorded.

## Drill expectations

In staging, pause database connectivity during create, exec/stream, extend, and
delete. Prove no unaudited create occurs, accepted existing host leases remain
bounded by TTL/resources, public mutations fail consistently, observations replay
once, the timed-out create reconciles to no more than one VM, and normal operations
resume only after the staged gate. Retain test, control-plane, host, gateway,
database, audit, and ledger evidence with customer content redacted.
