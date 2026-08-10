import { assert, report, request, required } from "./common.mjs";

const projectId = required(
  "NEHEMIAH_BILLING_PROJECT_ID",
  process.env.NEHEMIAH_TEST_PROJECT_ID || process.env.NEHEMIAH_PROJECT,
);
const minimumVcpuSeconds = Number(
  process.env.NEHEMIAH_BILLING_MIN_VCPU_SECONDS || 0,
);
if (!Number.isFinite(minimumVcpuSeconds) || minimumVcpuSeconds < 0) {
  throw new Error("NEHEMIAH_BILLING_MIN_VCPU_SECONDS must be nonnegative");
}
const from =
  process.env.NEHEMIAH_BILLING_FROM ||
  new Date(Date.now() - 86_400_000).toISOString();
const to = process.env.NEHEMIAH_BILLING_TO || new Date().toISOString();
const { value } = await request(
  `/v1/billing/usage?project_id=${encodeURIComponent(projectId)}&from=${encodeURIComponent(
    from,
  )}&to=${encodeURIComponent(to)}`,
);

assert(Array.isArray(value.usage), "billing response omitted usage rows");
const keys = new Set();
let vcpuSeconds = 0;
for (const row of value.usage) {
  assert(
    row.project_id === projectId,
    "billing response crossed the requested project boundary",
  );
  const key = `${row.usage_date}:${row.project_id}:${row.dimension}`;
  assert(!keys.has(key), `duplicate aggregate row ${key}`);
  keys.add(key);
  const quantity = Number(row.quantity);
  assert(
    Number.isFinite(quantity) && quantity >= 0,
    `invalid quantity for ${key}`,
  );
  if (row.dimension === "vcpu_seconds") vcpuSeconds += quantity;
}
assert(
  vcpuSeconds >= minimumVcpuSeconds,
  `vCPU usage ${vcpuSeconds} was below expected floor ${minimumVcpuSeconds}`,
);
report("nehemiah-billing-reconciliation", {
  project_id: projectId,
  rows: value.usage.length,
  vcpu_seconds: vcpuSeconds,
});
