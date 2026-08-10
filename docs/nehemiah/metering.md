# Nehemiah metering contract

Status: implementation contract; charging disabled until shadow-mode release gate  
Last updated: 2026-08-09

This document specifies how host observations become explainable usage. The
architectural decision is [ADR 0004](adr/0004-metering-ledger.md). Raw usage is an
append-only PostgreSQL ledger; daily summaries and Stripe reports are rebuildable
projections.

## Implemented shadow transport

Migration `0016_authoritative_metering.sql` and the corresponding host/control-plane
protocol implement observation capture in shadow mode. Rates and charging remain
disabled. Each live lease records a durable start after its VMM exists, cumulative
checkpoints, and a final observation before destructive cleanup. The host uses the
Linux boot ID and `CLOCK_BOOTTIME`, persists sequence and cumulative runtime/allowed-
egress high-waters, never evicts its bounded outbox, reserves terminal capacity, and
rejects new creates before saturation.

The control plane authenticates the current heartbeat credential generation, matches
the exact host/machine/lease generation/resources, and commits receipt, immutable
observation, contiguous high-water, raw integer events, and exception evidence in one
transaction. A delayed or duplicate observation cannot add usage twice. Gaps remain
pending; payload conflicts, boot changes, counter/monotonic resets, clock divergence,
and observations after closure quarantine the lease. Host loss closes at the last
accepted boundary rather than detection time. A recovery- or read-failure final is
explicitly marked `last_defensible`, records its reason, and leaves an immutable open
exception instead of pretending stale counters were a clean stop. During rolling deployment, a lease
continues on legacy metering until its start observation commits; the exact legacy
prefix is retained and any overlap is subtracted from host cumulative runtime.

This is implementation evidence only. Enabling rates still requires the live-KVM
restart/firewall-counter exercise and the approved continuous shadow window,
discrepancy thresholds, rebuild comparison, and Stripe shadow-export evidence listed
below.

## Principles

- Meter an observed, current lease—not an API request or mutable machine row.
- Use integer raw units and half-open intervals; never round each checkpoint.
- Make repeated and out-of-order delivery safe through deterministic identity.
- Keep resource quantity separate from price, plan, discounts, tax, and currency.
- Prefer a flagged gap and customer remediation over silently estimating usage.
- Corrections append evidence; accepted raw events are never edited or deleted.
- Stripe is an asynchronous sink and is never required for lifecycle cleanup.

## Dimensions and canonical units

Customer-facing dimensions use familiar units. The raw ledger retains finer
integer units so checkpoint frequency cannot change the bill.

| Dimension | Raw integer unit | Display/billing unit | Source |
| --- | --- | --- | --- |
| Compute | `vcpu_nanosecond` | vCPU-second | configured vCPU count × host monotonic runtime |
| Memory | `byte_nanosecond` | GiB-second | configured bytes × host monotonic runtime |
| Durable storage | `byte_second` | GiB-hour | provisioned/used-byte policy for the volume, timestamped on size change and checkpoint |
| Outbound bandwidth | `byte` | GiB | bytes accepted by the enforced customer-egress accounting point |
| Computer-use pass-through | provider-specific smallest integer unit | named upstream unit | verified upstream usage record |
| Inference pass-through | provider-specific token/request smallest integer unit | named upstream unit | verified upstream usage record |

One GiB is `2^30` bytes. A second is `10^9` nanoseconds. UTC defines calendar and
billing-period boundaries. The product and invoice must label GiB rather than GB.

### Rounding

Raw events are never rounded. Aggregation sums raw integers for an organization,
project, dimension, rate-card version, and billing period, then converts once
using exact decimal arithmetic. Price is rounded once to the currency's minor unit
at the documented invoice-line boundary. No floating-point arithmetic or
per-machine/per-checkpoint ceiling is allowed.

If the eventual rate card intentionally bills in whole resource units, its
versioned rule must state whether the aggregate is rounded up, down, or nearest.
Until that rule is approved, the ledger and customer usage API expose exact
fractional display units and shadow cost only.

## Runtime boundaries

Compute and memory usage begin at the host-confirmed Firecracker start for the
current lease generation and end at the earliest defensible one of:

- host-confirmed stop;
- the lease's enforced expiry;
- the host's last accepted cumulative observation plus a reconciled final bound; or
- an append-only administrative correction after incident review.

Boot after VMM start is included. Placement and artifact download before VMM start
are not. A failed create with no confirmed VMM start has zero compute/memory use.
Configured memory is metered during beta; RSS and balloon/free-page observations
are telemetry only. Paused-machine billing needs a separate rate-card decision and
is not inferred from process state.

An initial `running` transition still waits for guest-agent/readiness checks. The
separate start boundary means a slow or malicious image can consume resources
before it is customer-ready; that interval remains visible as `startup_usage` in
customer/support projections even if the beta rate card later credits it.

## Event model

Every accepted event has these logical fields:

| Field | Rule |
| --- | --- |
| `event_id` | Globally unique immutable identifier |
| `idempotency_key` | Deterministic identity unique across the ledger |
| `kind` | `start`, `checkpoint`, `stop`, `adjustment`, or dimension-specific observation |
| tenant | Organization and project IDs copied from the authoritative lease |
| resource | Public machine/volume ID where applicable; never a customer-supplied owner |
| lease | Lease ID and generation; mandatory for runtime usage |
| dimension/unit | Closed enum with the exact raw integer unit |
| interval | Half-open `[start_at, end_at)`; `end_at > start_at` for interval usage |
| quantity | Non-negative integer for raw usage; adjustments carry direction separately |
| counter | Host monotonic cumulative quantity/sequence where applicable |
| source | Host/service identity, boot ID, process identity, and observation type |
| time | Host observed time, control-plane received time, and database recorded time |
| correlation | Request, trace, operation, and machine-event IDs where available |
| adjustment metadata | Referenced event/summary, reason code, operator, approval, and ticket |

Database constraints reject missing tenant/lease ownership, negative raw
quantities, invalid intervals, unknown units, reused identity with different
payload, or an event outside its lease generation. Normal application roles may
insert valid events but cannot update/delete them.

### Deterministic identity

Host observations carry a stable host boot ID, lease generation, dimension, and
strictly increasing sequence/cumulative counter. The ingestion idempotency key is
derived from those values and the observation kind, not arrival time. Replaying
the same payload returns the existing event. Reusing the key with a different
payload is an integrity error and pages the metering owner.

Control-plane generated boundaries use the stable lifecycle operation ID. An
adjustment key includes the referenced source, approved correction record, and
revision so job retry cannot apply it twice.

## Observation protocol

1. When Firecracker starts, `nehemiahd` atomically records the lease generation,
   host boot/process identity, monotonic start, and a `start` observation before
   acknowledging the operation.
2. While the VM exists, the host emits cumulative checkpoints at the configured
   interval. A checkpoint reports cumulative runtime and byte counters, not a
   pre-rounded price or independently guessed delta.
3. On stop, TTL cleanup, or reconciled orphan cleanup, the host persists and emits
   the final cumulative observation before removing recoverable metadata.
4. The control plane validates host identity and current/known lease, then converts
   the new portion after the prior high-water mark into non-overlapping raw events.
5. Duplicate or late observations below the high-water mark are retained as
   ingestion evidence but add no usage. Counter regression, boot-ID change,
   overlap, or an unexplained gap enters the exception queue.

Host and control-plane wall clocks are monitored, but durations use a host
monotonic clock tied to a recorded boot ID. Control-plane receive time constrains
implausible wall-time claims. A host cannot assign tenant ownership, rate, credit,
or price.

## Storage and bandwidth

The approved storage basis—provisioned bytes or measured logical bytes—must be
fixed in the rate card before charging. Size changes create timestamped
observations so aggregation can integrate byte-seconds; an hourly report must not
round a partial interval into a full GiB-hour per volume.

Outbound bandwidth is counted once at the narrowest common enforced egress point,
excluding intra-platform host/control traffic and object downloads that are not
defined as customer egress. Retries below that accounting point must not double
count. Counter resets and interface replacement include a stable interface/boot
identity. Inbound bandwidth is telemetry-only unless a future ADR adds it.

## Reconciliation

The reconciliation job groups evidence by lease generation and dimension, then
checks:

- exactly zero or one start and a monotonic checkpoint sequence;
- no overlap or gap between accepted raw intervals;
- quantity consistent with configured vCPU/memory and elapsed monotonic time;
- stop/expiry/lost boundary consistent with lifecycle and host heartbeats;
- capacity release and final usage emitted exactly once; and
- daily projection totals equal a clean replay of raw events through a recorded watermark.

Host loss is not filled to “now.” Reconciliation closes at the last defensible
observation or enforced lease boundary, marks confidence/reason, and queues any
ambiguous amount for review or customer credit. A machine declared `lost` never
resumes the same lease generation if its host later returns.

The exception queue has owner, age, value-at-risk, tenant, reason, and resolution.
No ambiguous event is exported to Stripe until resolved by original evidence or
an approved append-only adjustment.

## Aggregation, rates, and Stripe

Daily UTC summaries group by organization, project, dimension/unit, and immutable
rate-card version. They record raw total, converted quantity, source event count,
minimum/maximum event time, ledger watermark, build version, and reconciliation
status. Rebuilding from the same watermark must be byte-for-byte deterministic.

Rate cards are immutable once referenced. A new price, included allowance,
startup credit, tier, pass-through treatment, or rounding rule creates a new
version with an effective interval. Pricing code consumes summaries; it does not
mutate raw usage.

Stripe reports use a deterministic key derived from billing account, period,
dimension, rate-card version, and ledger watermark. Webhook signatures and event
IDs are verified; webhook replay is safe. Reporting retries with alerting on age
and value at risk. Stripe downtime does not block machine stop, expiration,
capacity release, ledger ingestion, or customer usage visibility.

## Shadow-mode release gate

Charging is disabled until all of the following hold:

- replay, duplicate, out-of-order, create-timeout, daemon-restart, stop-retry,
  host-loss, clock-skew, and counter-reset fixtures pass;
- daily raw-ledger rebuild equals stored summaries and Stripe shadow export;
- host-observed resource metrics reconcile to ledger totals within an approved,
  documented discrepancy threshold for the full approved observation window;
- every discrepancy above threshold is explained, corrected append-only, and has
  a prevention/detection owner;
- customer usage views state boundaries, units, rounding, confidence, credits,
  and update lag; and
- billing support can trace a sample invoice line to immutable events and can
  apply/reverse a documented credit without editing history.

The metering owner must fill these before enabling charges:

| Gate | Approved value | Evidence |
| --- | --- | --- |
| Checkpoint interval and maximum tolerated gap | `TBD` | `TBD` |
| Reconciliation discrepancy threshold | `TBD` | `TBD` |
| Continuous shadow observation window | `TBD` | `TBD` |
| Storage basis and sampling policy | `TBD` | `TBD` |
| Rate-card rounding and startup-credit policy | `TBD` | `TBD` |
| Ledger/audit retention | `TBD` | `TBD` |

These values require measured alpha behavior and product/finance approval; they
must not be guessed solely to make the checklist look complete.
