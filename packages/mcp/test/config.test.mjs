import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, redactSecrets, safeEndpoint } from "../config.mjs";

test("API-key configuration selects cloud and carries project", () => {
  const config = configFromEnv({
    NEHEMIAH_API_KEY: "bc_secret",
    NEHEMIAH_PROJECT: "project-1",
  });
  assert.equal(config.target, "cloud");
  assert.equal(config.baseUrl, "https://api.boringcomputers.com");
  assert.equal(config.apiKey, "bc_secret");
  assert.equal(config.project, "project-1");
});

test("legacy local configuration remains available", () => {
  const config = configFromEnv({ NEHEMIAH_URL: "http://127.0.0.1:8088" });
  assert.equal(config.target, "local");
  assert.equal(config.baseUrl, "http://127.0.0.1:8088");
});

test("API-key staging URLs retain cloud behavior", () => {
  const config = configFromEnv({
    NEHEMIAH_API_KEY: "bc_secret",
    NEHEMIAH_URL: "https://staging.example",
  });
  assert.equal(config.target, "cloud");
  assert.equal(config.baseUrl, "https://staging.example");
});

test("safe endpoint never includes URL credentials", () => {
  assert.equal(
    safeEndpoint("https://user:secret@example.com/path"),
    "https://example.com",
  );
});

test("diagnostic redaction removes API and capability tokens", () => {
  const message = redactSecrets(
    "failed https://gateway.example/tty?token=cap.secret&x=1 Authorization: Bearer bc_live_secret",
  );
  assert.equal(message.includes("cap.secret"), false);
  assert.equal(message.includes("bc_live_secret"), false);
  assert.match(message, /<redacted>/);
});
