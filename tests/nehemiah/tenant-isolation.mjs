import {
  assert,
  createMachine,
  destroyMachine,
  report,
  request,
  required,
  waitForMachine,
} from "./common.mjs";

const tenantAKey = required(
  "NEHEMIAH_TEST_TENANT_A_KEY",
  process.env.NEHEMIAH_TEST_API_KEY,
);
const tenantAProject = required(
  "NEHEMIAH_TEST_TENANT_A_PROJECT_ID",
  process.env.NEHEMIAH_TEST_PROJECT_ID,
);
const tenantBKey = required("NEHEMIAH_TEST_TENANT_B_KEY");

let machine;
try {
  machine = await createMachine({
    apiKey: tenantAKey,
    projectId: tenantAProject,
  });
  await waitForMachine(machine.id, { apiKey: tenantAKey });

  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["DELETE", "", undefined],
    ["POST", "/exec", { command: "true" }],
    ["POST", "/sessions", { capabilities: ["tty"] }],
  ]) {
    const { status } = await request(
      `/v1/machines/${encodeURIComponent(machine.id)}${suffix}`,
      { apiKey: tenantBKey, method, body, expected: [404] },
    );
    assert(
      status === 404,
      `${method} ${suffix || "/"} disclosed the other tenant`,
    );
  }

  const { value: list } = await request("/v1/machines", { apiKey: tenantBKey });
  assert(
    Array.isArray(list.machines) &&
      !list.machines.some(({ id }) => id === machine.id),
    "tenant B list included tenant A machine",
  );
  report("nehemiah-tenant-isolation", { machine_id: machine.id });
} finally {
  if (machine?.id) await destroyMachine(machine.id, tenantAKey);
}
