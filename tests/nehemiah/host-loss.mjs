import {
  assert,
  createMachine,
  destroyMachine,
  positiveInteger,
  report,
  request,
  required,
  waitForMachine,
} from "./common.mjs";

const injectorUrl = required("NEHEMIAH_HOST_LOSS_WEBHOOK");
const injectorToken = required("NEHEMIAH_HOST_LOSS_TOKEN");
const parsedInjectorUrl = new URL(injectorUrl);
if (parsedInjectorUrl.protocol !== "https:") {
  throw new Error("NEHEMIAH_HOST_LOSS_WEBHOOK must use HTTPS");
}
const expectedHostId = process.env.NEHEMIAH_TEST_HOST_ID;
let isolatedHostId = expectedHostId;
let isolated = false;
let machine;
try {
  machine = await createMachine();
  machine = await waitForMachine(machine.id);
  const injection = await fetch(injectorUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${injectorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machine_id: machine.id,
      expected_host_id: expectedHostId,
      action: "isolate",
      reason: "staging-host-loss-drill",
    }),
  });
  if (!injection.ok)
    throw new Error(`host-loss injector returned ${injection.status}`);
  // A successful isolate response may have changed the fleet even if parsing
  // its body fails. From this point onward restoration is mandatory.
  isolated = true;
  const injectionResult = await injection.json();
  isolatedHostId = injectionResult.host_id || expectedHostId;
  assert(isolatedHostId, "host-loss injector omitted host_id");

  const deadline =
    Date.now() +
    positiveInteger("NEHEMIAH_HOST_LOSS_TIMEOUT_MS", 180_000, 900_000);
  let observed;
  while (Date.now() < deadline) {
    const response = await request(
      `/v1/machines/${encodeURIComponent(machine.id)}`,
    );
    observed = response.value;
    if (observed.state === "lost") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert(observed?.state === "lost", "affected machine was not marked lost");

  const replacement = await createMachine();
  try {
    await waitForMachine(replacement.id);
  } finally {
    await destroyMachine(replacement.id);
  }
  report("nehemiah-host-loss", {
    host_id: isolatedHostId,
    lost_machine_id: machine.id,
  });
} finally {
  if (machine?.id) {
    await destroyMachine(machine.id).catch(() => undefined);
  }
  if (isolated) {
    const restored = await fetch(injectorUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${injectorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        host_id: isolatedHostId,
        machine_id: machine?.id,
        action: "restore",
        reason: "staging-host-loss-drill",
      }),
    });
    if (!restored.ok) {
      throw new Error(
        `CRITICAL: host-loss injector failed to restore ${isolatedHostId} (${restored.status})`,
      );
    }
  }
}
