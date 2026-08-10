import assert from "node:assert/strict";
import test from "node:test";
import { dispatch, safeErrorMessage, TOOLS } from "../index.mjs";

const machine = {
  id: "local-machine",
  status: "running",
  ready: true,
  template: "python",
  created_at: "2026-08-09T00:00:00Z",
  expires_at: "2026-08-09T00:10:00Z",
};

test("local catalog omits cloud-only and durable-idempotency launch fields", () => {
  const launch = TOOLS.find((tool) => tool.name === "launch_computer");
  assert.ok(launch);
  for (const field of [
    "template_id",
    "region",
    "size",
    "allowed_hostnames",
    "allowed_cidrs",
    "idempotency_key",
  ]) {
    assert.equal(launch.inputSchema.properties[field], undefined);
  }
  assert.ok(launch.inputSchema.properties.internet);
  assert.ok(launch.inputSchema.properties.volume);
  assert.deepEqual(launch.inputSchema.required, []);
});

test("local mutations are single-attempt and never promise durable recovery", async (context) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/v1/volumes") {
      return new Response(
        JSON.stringify({
          id: "volume-1",
          created_at: "2026-08-09T00:00:00Z",
          expires_at: "2026-08-10T00:00:00Z",
          quota_mb: 1024,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(machine), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  await dispatch("launch_computer", { template: "python", ttl_seconds: 600 });
  await dispatch("extend_computer", { id: machine.id, ttl_seconds: 600 });
  await dispatch("fork_computer", { id: machine.id, count: 1 });
  await dispatch("create_volume", { ttl_seconds: 600 });

  assert.equal(requests.length, 4);
  for (const { init } of requests) {
    assert.equal(new Headers(init?.headers).has("idempotency-key"), false);
  }

  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("completion unknown", { status: 503 });
  };
  await assert.rejects(
    dispatch("launch_computer", { template: "python", ttl_seconds: 600 }),
    (error) => {
      assert.equal(error?._tag, "ResponseError");
      assert.equal(
        safeErrorMessage(error).includes("Retry the unchanged operation"),
        false,
      );
      return true;
    },
  );
  assert.equal(attempts, 1);
});
