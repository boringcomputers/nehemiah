# Nehemiah observability

The control plane, gateway, and host daemon emit allowlisted OpenTelemetry
traces and metrics when explicitly enabled. Production control-plane/gateway
processes and every managed host require a complete enabled exporter and fail
startup if it is absent; local development defaults perform no telemetry network
I/O. This directory contains the production
collector, Prometheus alerts, Grafana provisioning, five versioned dashboards,
and an offline configuration/redaction validator.

A deployment is not production-ready merely because these artifacts exist.
Before admitting external tenants, deploy them in the target region and retain
the live-backend evidence described below.

## Versioned artifacts

- `otel-collector.yaml`: private authenticated OTLP/HTTP TLS ingress, strict
  trace/metric attribute allowlists, bounded memory, and a disk-backed queue.
- `prometheus-alerts.yaml`: twelve SLO, no-data, fleet, dependency, and delivery
  alerts. Every rule names an owner, severity, dashboard, and runbook.
- `grafana/provisioning`: code-owned Prometheus datasource and dashboard provider.
- `grafana/dashboards/*-v1.json`: customer journey, fleet capacity, machine
  lifecycle, gateway, and integrity dashboards with stable UIDs and versions.
- `validate.mjs`: structural checks plus canary-secret tests for collector
  span/metric attributes. The application test suites exercise structured-log
  redaction with the same canary class.

## Private collection boundary

Run the pinned OpenTelemetry Collector Contrib artifact in the private service
network. Port `4318` is the sole application ingest port and requires TLS plus
Basic authentication against `/run/secrets/otel-ingest.htpasswd`. Give every
process/host a unique username and random password. Ports `9464` (application
Prometheus), `8888` (collector self-metrics), and `13133` (health) bind loopback;
scrape them from a same-host agent. Guests, public preview origins, and public
load balancers must have no route to any collector port.

The collector configuration is validated against this immutable multi-platform
image:

```text
otel/opentelemetry-collector-contrib@sha256:8164eab2e6bca9c9b0837a8d2f118a6618489008a839db7f9d6510e66be3923c
```

Mount a root-owned certificate/key at `otel-ingest.crt`/`otel-ingest.key`. Its
chain must be in every application's operating-system trust store; none of the
exporters supports an insecure or skip-verification mode. Mount the backend
Basic username/password in their separate files, set
`OTEL_BACKEND_AUTHORITY=DNS-host[:port]`, and allowlist collector egress to that
authority. The config prefixes `https://`, so an environment value cannot
silently select plaintext OTLP.

Required resource attributes are deployment-controlled:

- `service.name`: `nehemiah-control`, `nehemiah-gateway`, or `nehemiahd`
- `service.version`: immutable release version or source commit
- `deployment.environment.name`: `development`, `test`, `staging`, or `production`
- `cloud.region`: a configured Nehemiah region
- `service.instance.id`: stable process/container/host instance identifier

The gateway starts the public-edge trace. Trusted internal calls propagate W3C
`traceparent`/`tracestate`; baggage is never accepted or emitted. Metric and
span attributes contain only the collector-enforced keys in the checked-in
allowlists. No signal may include:

- authorization, cookies, keys, capability/host tokens, or signed URLs;
- query strings, request/response bodies, commands, or environment values;
- terminal, VNC, agent, preview, file, or database statement contents;
- customer-provided names/labels/content, filesystem paths, error messages or
  stacks; or
- raw customer or host IPs.

Application exporters use TLS, sampled traces, bounded batch queues, finite
timeouts, and periodic export. The collector adds retry/backoff and a 10,000
batch fsynced queue under `/var/lib/otelcol`. Export is asynchronous: backend
failure is observable but never authorizes work or changes a customer response
after a side effect. Explicitly enabling an incomplete/insecure exporter fails
startup; an already configured backend becoming unavailable does not block the
business path.

## Application configuration

Leave every `NEHEMIAH_OTEL_*` value unset locally. To enable a process, set the
complete group below. A partial group, non-HTTPS origin, malformed auth header,
unbounded timeout, invalid sampling ratio, or production credential reuse fails
startup. Each process gets a different Basic credential from the collector's
htpasswd file.

```dotenv
NEHEMIAH_OTEL_ENABLED=true
NEHEMIAH_OTEL_ENDPOINT=https://otel-collector.internal.example
NEHEMIAH_OTEL_AUTHORIZATION=Basic <base64-unique-username-colon-password>
NEHEMIAH_SERVICE_VERSION=2026.08.09
NEHEMIAH_INSTANCE_ID=stable-instance-id
NEHEMIAH_DEPLOYMENT_ENVIRONMENT=staging
NEHEMIAH_OTEL_EXPORT_INTERVAL_MS=15000
NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS=10000
NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO=0.1
```

The gateway also requires `NEHEMIAH_REGION`; the control plane uses
`NEHEMIAH_DEFAULT_REGION`; nehemiahd uses its existing `NEHEMIAH_REGION`.
Authorization values are redacted from configuration rendering and are never
included in exporter errors or telemetry attributes.

## Emitted RED and USE signals

Counters are monotonic and durations are seconds histograms. Metric labels are
fixed route templates and bounded enums; URLs, identifiers, error text, API-key
prefixes, and customer input are not metric labels.

Control plane:

- HTTP request count, duration, active requests, and status class by normalized
  route and method;
- create/fork/extend/destroy/template-publish outcomes;
- fixed-name lifecycle/reconciliation/billing/cleanup job count and duration; and
- database total, idle, and waiting connection gauges.

Gateway:

- HTTP/WebSocket request count, duration, active requests, and status class by
  normalized route and method;
- opened/active streams by fixed capability; and
- aggregate bytes by capability and fixed direction (never tenant/socket labels).

Host:

- HTTP RED and create/destroy/fork/extend/template export/activation outcomes;
- control-plane synchronization count and duration;
- total/available CPU, memory, and disk; machine counts by fixed state; and
- bounded host health state and KVM availability.

Scheduler-reason detail, audit/usage backlog age, gateway close reasons/cache,
cgroup hits, and template-cache integrity require additional business-owned
counters before their corresponding panels can become release-blocking. Their
absence is not represented as completed evidence.

## Dashboards and alerts

Mount `grafana/provisioning` into Grafana's provisioning directory and
`grafana/dashboards` at `/var/lib/grafana/dashboards/nehemiah`. Set
`PROMETHEUS_URL` to the authenticated private Prometheus origin. The provider is
non-editable so production changes return through version control.

Load `prometheus-alerts.yaml` into the same Prometheus used by the dashboards.
Initial CPU/memory and error-ratio thresholds must be recalibrated from staging
without changing label cardinality. Route `severity=page` to the on-call path and
`severity=ticket` to the owning queue. Related runbooks:

- [debug a machine](../../docs/nehemiah/runbooks/debug-machine.md)
- [host loss](../../docs/nehemiah/runbooks/host-loss.md)
- [capacity exhaustion](../../docs/nehemiah/runbooks/capacity-exhaustion.md)
- [database outage](../../docs/nehemiah/runbooks/database-outage.md)

## Validation

Run the repository validator first:

```sh
node deploy/observability/validate.mjs
```

Validate the real collector decoder and PromQL parser using immutable images:

```sh
docker run --rm -e OTEL_BACKEND_AUTHORITY=backend.example.test:4318 \
  -v "$PWD/deploy/observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib@sha256:8164eab2e6bca9c9b0837a8d2f118a6618489008a839db7f9d6510e66be3923c \
  validate --config=/etc/otelcol-contrib/config.yaml

docker run --rm --entrypoint=/bin/promtool \
  -v "$PWD/deploy/observability/prometheus-alerts.yaml:/etc/prometheus/nehemiah-alerts.yaml:ro" \
  prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996 \
  check rules /etc/prometheus/nehemiah-alerts.yaml
```

These are offline/schema checks. They do not contact an OTLP backend. Grafana
JSON and provisioning YAML are parsed and checked by `validate.mjs`.

## Release evidence

Before promoting an environment, retain:

1. collector, alert, and dashboard configuration at the release commit;
2. a redaction canary showing secrets/content absent from logs, spans, metrics,
   errors, and URLs;
3. dashboard exports showing all implemented signals receiving current data;
4. one fired-and-acknowledged test notification for each alert route;
5. host-loss, database-outage, capacity, and gateway-stream drill timestamps; and
6. the completed [security checklist](../../docs/nehemiah/security-checklist.md)
   and release ticket.

No checked-in test contacts a live exporter or backend. Until the above evidence
exists for the deployed release and region, central telemetry remains a release
blocker. See [SLOs](../../docs/nehemiah/slo.md) and the
[threat model](../../docs/nehemiah/threat-model.md) for the wider gates.
