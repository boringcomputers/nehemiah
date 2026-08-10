# Nehemiah staging test harness

These commands are intentionally live-environment gates, not mocked unit tests:

```bash
npm run test:nehemiah:smoke
npm run test:nehemiah:tenant-isolation
npm run test:nehemiah:host-loss
npm run test:nehemiah:billing-reconciliation
npm run test:nehemiah:load
```

All commands use `NEHEMIAH_TEST_URL` (or `NEHEMIAH_URL`) and scoped staging
credentials. Smoke uses `NEHEMIAH_TEST_API_KEY` and `NEHEMIAH_TEST_PROJECT_ID`.
Non-loopback targets and the host-loss injector must use HTTPS; a local lab may
opt into plaintext explicitly with `NEHEMIAH_TEST_ALLOW_INSECURE=1` for the API.
Tenant isolation additionally requires independently issued
`NEHEMIAH_TEST_TENANT_A_KEY`, `NEHEMIAH_TEST_TENANT_A_PROJECT_ID`, and
`NEHEMIAH_TEST_TENANT_B_KEY` values.

The host-loss drill never shells into a host. It requires an approved staging-only
injector in `NEHEMIAH_HOST_LOSS_WEBHOOK`, its bearer credential in
`NEHEMIAH_HOST_LOSS_TOKEN`, and an expendable synthetic machine. The injector must
resolve that machine's backing host, return its `host_id`, implement `isolate` and
`restore` actions, and reject production targets. `NEHEMIAH_TEST_HOST_ID` may pin
the expected host when the drill topology requires it. Once isolation succeeds,
the harness treats restoration as mandatory and fails loudly if the restore call
does not succeed; the operator must then follow the host-loss runbook immediately.

Billing reconciliation checks tenant/project boundaries, aggregate uniqueness,
nonnegative quantities, and the configured `NEHEMIAH_BILLING_MIN_VCPU_SECONDS`
floor for `NEHEMIAH_BILLING_PROJECT_ID`. Load defaults to 1,000 requests with 25
workers and a 1% error ceiling. It also creates an expendable machine, opens an
authenticated TTY WebSocket, and requires that stream to remain open for
`NEHEMIAH_LOAD_WS_HOLD_MS` (15 seconds by default) while the REST load runs.
`NEHEMIAH_LOAD_SKIP_WS=1` is an explicit local-lab opt-out; the staging deployment
gate intentionally does not set it. Override load values only with reviewed
staging limits.
