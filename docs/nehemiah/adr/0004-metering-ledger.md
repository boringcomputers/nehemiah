# ADR 0004: Append-only idempotent usage ledger

- Status: accepted
- Date: 2026-08-08

## Context

Distributed create, checkpoint, stop, retry, daemon restart, and host-loss paths
can report the same runtime more than once or omit a final event. Directly
incrementing a mutable monthly counter would make billing disputes difficult to
explain and corrections impossible to audit. Stripe availability must not decide
whether a machine can be cleaned up.

## Decision

Record raw usage as immutable `usage_events` in PostgreSQL. Treat daily/monthly
summaries and Stripe reports as rebuildable projections, not the source ledger.

### Ledger contract

Each event contains a globally unique event ID, deterministic idempotency key,
organization, project, public machine ID where applicable, lease generation,
dimension, integer quantity, canonical unit, half-open interval `[start, end)`,
source, observed-at time, recorded-at time, and trace/request identifiers. Prices
and currency are not embedded in raw resource events.

The initial dimensions and units are:

- vCPU time in vCPU-seconds;
- configured memory in GiB-seconds, represented internally as byte-seconds to
  avoid fractional arithmetic;
- durable storage in GiB-hours, represented internally as byte-seconds;
- outbound customer bandwidth in bytes; and
- optional computer-use or inference pass-through in the upstream provider's
  smallest integer unit, kept in separate dimensions.

Host-confirmed Firecracker start begins compute reservation usage; confirmed stop
or the reconciled lease cutoff ends it. Boot time after VMM start is included.
Failed placement before VMM start has zero compute usage. Configured memory, not
observed RSS, is billed during beta. Calendar summaries use UTC.

Hosts report start, monotonic cumulative checkpoints, and stop observations. The
control plane converts new deltas into non-overlapping interval events. A unique
constraint on the deterministic idempotency key makes repeated delivery a no-op.
The ledger rejects negative quantities, invalid intervals, unknown dimensions,
and events outside the applicable lease generation.

Corrections never update or delete an accepted raw event. A privileged,
reason-bearing adjustment event references the original event and reverses or
adds a quantity. Adjustments and projection rebuilds are audited.

### Reconciliation and billing

- A reconciler compares host observations, control-plane leases, lifecycle
  events, and usage checkpoints. Gaps, overlaps, counter resets, and clock skew
  are quarantined for correction rather than guessed into an invoice.
- Host loss closes usage at the last defensible checkpoint/lease boundary and
  flags the result. The policy must favor explainability and customer remediation
  over billing an unobserved interval.
- Daily organization summaries are materialized from the raw ledger and can be
  rebuilt deterministically.
- Rate cards are immutable, versioned, and applied after aggregation. A summary
  records the rate-card version and the event watermark it covers.
- Stripe receives idempotent aggregate reports asynchronously. Stripe failure
  creates retry/backlog alerts but never blocks stop, TTL cleanup, or capacity release.
- Metering runs in shadow mode through alpha. Charging stays disabled until the
  documented discrepancy threshold is met for the full release-gate window.

## Consequences

### Positive

- Duplicate messages and retries do not double bill.
- Every invoice quantity can be traced to raw observations and explicit corrections.
- Projections, price experiments, and Stripe reports can be rebuilt independently.
- Runtime cleanup is decoupled from the billing processor.

### Costs and constraints

- Event volume and projection jobs require partitioning/retention planning.
- Counter resets, clock quality, host loss, and late events need visible exception queues.
- Application database roles must prohibit update/delete on usage and audit tables.
- The product must disclose the start boundary, configured-resource basis, rounding,
  storage sampling, pass-through units, and correction policy.

## Alternatives considered

- **Mutable per-machine or monthly counters.** Rejected because retries and manual
  corrections destroy provenance.
- **Stripe as the source ledger.** Rejected because it couples machine cleanup to
  a third party and lacks host/control-plane reconciliation context.
- **Bill only from control-plane wall time.** Rejected because API timeouts and
  host loss can diverge from actual runtime.
- **Bill from observed memory RSS during beta.** Rejected until balloon/free-page
  telemetry and stress tests establish a safe, comprehensible policy.

## Validation

- Replaying every start/checkpoint/stop delivery produces the same totals.
- Concurrent checkpoint writers cannot create overlapping usage for one lease and dimension.
- Host restart, create timeout, stop retry, and host-loss fixtures reconcile to
  documented quantities with no negative or duplicate intervals.
- Rebuilding daily summaries from raw events matches stored summaries exactly.
- A Stripe outage leaves ledger ingestion and machine cleanup healthy and exposes
  report lag through an alert.
