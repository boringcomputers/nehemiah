import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedInteger,
  OperationRecovery,
  requiredIdempotencyKey,
  withOperationRecovery,
} from "../operation.mjs";

test("bounds integer operation arguments before SDK dispatch", () => {
  assert.equal(boundedInteger(undefined, 600, 15, 86400, "ttl_seconds"), 600);
  assert.equal(boundedInteger(86400, 600, 15, 86400, "ttl_seconds"), 86400);
  for (const value of [14, 86401, 1.5, Number.NaN]) {
    assert.throws(() => boundedInteger(value, 600, 15, 86400, "ttl_seconds"));
  }
});

test("requires a caller-owned stable idempotency key", () => {
  assert.equal(
    requiredIdempotencyKey({ idempotency_key: "task:123.retry-1" }),
    "task:123.retry-1",
  );
  assert.equal(
    requiredIdempotencyKey({ idempotency_key: "x".repeat(128) }),
    "x".repeat(128),
  );
  for (const value of [undefined, "", "bad\r\nheader", "x".repeat(129)]) {
    assert.throws(() => requiredIdempotencyKey({ idempotency_key: value }));
  }
});

test("retains the exact recovery key when a durable call is ambiguous", async () => {
  const cause = { _tag: "RequestError", method: "POST", path: "/v1/machines" };
  await assert.rejects(
    withOperationRecovery(async () => {
      throw cause;
    }, "stable-key"),
    (error) =>
      error instanceof OperationRecovery &&
      error.cause === cause &&
      error.idempotencyKey === "stable-key",
  );
});

test("does not recommend retrying deterministic operation failures", async () => {
  for (const cause of [
    { _tag: "ResponseError", status: 400 },
    { _tag: "ResponseError", status: 401 },
    { _tag: "ResponseError", status: 403 },
    { _tag: "ResponseError", status: 404 },
    { _tag: "ResponseError", status: 409 },
  ]) {
    await assert.rejects(
      withOperationRecovery(async () => {
        throw cause;
      }, "stable-key"),
      (error) => error === cause,
    );
  }
});

test("retains recovery guidance for retryable API responses", async () => {
  for (const status of [408, 425, 429, 500, 503]) {
    await assert.rejects(
      withOperationRecovery(async () => {
        throw { _tag: "ResponseError", status };
      }, "stable-key"),
      (error) =>
        error instanceof OperationRecovery &&
        error.cause.status === status &&
        error.idempotencyKey === "stable-key",
    );
  }
});
