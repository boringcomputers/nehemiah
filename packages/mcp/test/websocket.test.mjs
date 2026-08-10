import assert from "node:assert/strict";
import test from "node:test";
import { agentSocketTarget } from "../websocket.mjs";

test("managed agent capabilities use the WebSocket subprotocol and never the URL", () => {
  const target = agentSocketTarget({
    target: "cloud",
    baseUrl: "https://api.example",
    gatewayUrl: "https://gateway.example/",
    machineId: "m_abc",
    goal: "build a site",
    capabilityToken: "signed.jwt.value",
  });

  const url = new URL(target.url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/v1/machines/m_abc/shell-agent");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(target.url.includes("signed.jwt.value"), false);
  assert.equal(target.protocol, "nehemiah.capability.signed.jwt.value");
  assert.deepEqual(JSON.parse(target.initialMessage), {
    type: "start",
    version: 1,
    goal: "build a site",
  });
});

test("legacy local agent auth remains query-scoped for self-hosted daemons", () => {
  const target = agentSocketTarget({
    target: "local",
    baseUrl: "http://127.0.0.1:8080",
    gatewayUrl: "http://127.0.0.1:8080",
    machineId: "machine 1",
    goal: "say hi",
    apiKey: "local-secret",
  });

  const url = new URL(target.url);
  assert.equal(url.protocol, "ws:");
  assert.equal(url.pathname, "/v1/machines/machine%201/shell-agent");
  assert.equal(url.searchParams.get("token"), "local-secret");
  assert.equal(url.searchParams.has("goal"), false);
  assert.equal(target.protocol, undefined);
  assert.deepEqual(JSON.parse(target.initialMessage), {
    type: "start",
    version: 1,
    goal: "say hi",
  });
});

test("managed agent target rejects missing or header-breaking capabilities", () => {
  for (const capabilityToken of [undefined, "", "bad,token", "bad\r\ntoken"]) {
    assert.throws(() =>
      agentSocketTarget({
        target: "cloud",
        baseUrl: "https://api.example",
        gatewayUrl: "https://gateway.example",
        machineId: "m_abc",
        goal: "task",
        capabilityToken,
      }),
    );
  }
});

test("managed agent targets reject unsafe origins and unbounded goals", () => {
  for (const gatewayUrl of [
    "http://gateway.example",
    "https://gateway.example/path",
    "https://gateway.example/?goal=leak",
  ]) {
    assert.throws(() =>
      agentSocketTarget({
        target: "cloud",
        baseUrl: "https://api.example",
        gatewayUrl,
        machineId: "m_abc",
        goal: "task",
        capabilityToken: "signed.jwt.value",
      }),
    );
  }
  for (const goal of ["", "  ", "x".repeat(4097)]) {
    assert.throws(() =>
      agentSocketTarget({
        target: "cloud",
        baseUrl: "https://api.example",
        gatewayUrl: "https://gateway.example",
        machineId: "m_abc",
        goal,
        capabilityToken: "signed.jwt.value",
      }),
    );
  }
});
