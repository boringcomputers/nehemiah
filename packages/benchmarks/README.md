# Nehemiah release benchmarks

Run the benchmark only against an isolated staging project with enough quota for
one headless VM, one desktop VM, and the configured fork batch:

```bash
NEHEMIAH_URL=https://api.staging.example \
NEHEMIAH_API_KEY=... \
NEHEMIAH_PROJECT=... \
NEHEMIAH_BENCH_ITERATIONS=20 \
NEHEMIAH_BENCH_RESTORE_TEMPLATE_ID=... \
NEHEMIAH_BENCH_REQUIRE_COMPLETE=1 \
npm run benchmark -w @nehemiah/benchmarks
```

The runner records cold boot, published-template restore, first exec, bounded
CPU plus sequential/random fsync probes, single and all-ready batch fork, TTY and
VNC setup, isolated preview round trip, and cleanup distributions. Managed
networking is hard-disabled for the private beta, so the runner creates every
machine with `network_policy.mode=off` and does not claim DNS/HTTPS egress
coverage. Failed and
timed-out attempts remain in the schema-v2 JSON output. It exits nonzero for any
failed sample, a material baseline regression, or (when
`NEHEMIAH_BENCH_REQUIRE_COMPLETE=1`) an incomplete cohort.

Use `NEHEMIAH_BENCH_BASELINE` to compare against a like-for-like JSON report and
`NEHEMIAH_BENCH_MAX_REGRESSION` to set the allowed median regression fraction.
Record `NEHEMIAH_BENCH_HOST_TYPE`, `NEHEMIAH_BENCH_IMAGE_DIGEST`, and
`NEHEMIAH_BENCH_COMMIT` so results cannot be mistaken for another hardware or
image cohort. Numeric SLO targets must come from retained Latitude staging data.
Network benchmarks remain a prerequisite for any later release that re-enables
managed egress with aggregate tenant and host quotas.

The public runner deliberately cannot measure a direct private-host preview
baseline. Compute gateway overhead from a separate trusted, credential-redacted
host-side probe and join it to the same release record; never expose a host token
or private route to this process.
