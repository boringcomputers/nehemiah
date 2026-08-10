import { performance } from "node:perf_hooks";
import {
  apiUrl,
  assert,
  createMachine,
  delay,
  destroyMachine,
  positiveInteger,
  report,
  request,
  required,
  waitForMachine,
} from "./common.mjs";

required("NEHEMIAH_TEST_API_KEY", process.env.NEHEMIAH_API_KEY);

const concurrency = positiveInteger("NEHEMIAH_LOAD_CONCURRENCY", 25, 1_000);
const requests = positiveInteger("NEHEMIAH_LOAD_REQUESTS", 1_000, 1_000_000);
const rateLimitProbes = positiveInteger(
  "NEHEMIAH_LOAD_RATE_LIMIT_PROBES",
  700,
  10_000,
);
const webSocketHoldMs = positiveInteger(
  "NEHEMIAH_LOAD_WS_HOLD_MS",
  15_000,
  600_000,
);
const skipWebSocket = process.env.NEHEMIAH_LOAD_SKIP_WS === "1";
const maximumErrorRate = Number(
  process.env.NEHEMIAH_LOAD_MAX_ERROR_RATE || 0.01,
);
if (
  !Number.isFinite(maximumErrorRate) ||
  maximumErrorRate < 0 ||
  maximumErrorRate > 1
) {
  throw new Error("NEHEMIAH_LOAD_MAX_ERROR_RATE must be between 0 and 1");
}

const runHttpLoad = async () => {
  let next = 0;
  let failures = 0;
  const latencies = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= requests) return;
        const requestStarted = performance.now();
        try {
          await request(
            index % 10 === 0 ? "/v1/machines" : "/healthz",
            index % 10 === 0 ? {} : { apiKey: null },
          );
        } catch {
          failures += 1;
        } finally {
          latencies.push(performance.now() - requestStarted);
        }
      }
    }),
  );
  return { failures, latencies };
};

const verifyRestAdmission = async () => {
  const forged = `bc_live_deadbeefcafe_${"A".repeat(43)}`;
  let next = 0;
  let limited = 0;
  let unauthorized = 0;
  let retryAfter;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rateLimitProbes) }, async () => {
      while (true) {
        const index = next++;
        if (index >= rateLimitProbes) return;
        const response = await fetch(`${apiUrl()}/v1/machines`, {
          redirect: "error",
          headers: { authorization: `Bearer ${forged}` },
        });
        if (response.status === 401) unauthorized += 1;
        else if (response.status === 429) {
          limited += 1;
          const value = Number(response.headers.get("retry-after"));
          assert(
            Number.isSafeInteger(value) && value > 0 && value <= 3_600,
            `rate-limit Retry-After is invalid: ${response.headers.get("retry-after")}`,
          );
          retryAfter = value;
        } else {
          const detail = (await response.text()).slice(0, 512);
          throw new Error(
            `admission probe ${index} returned ${response.status}: ${detail}`,
          );
        }
        await response.body?.cancel();
      }
    }),
  );
  assert(limited > 0, "REST admission probes never produced a 429 response");
  return { limited, unauthorized, retryAfter };
};

const openWebSocket = async (url, protocol) => {
  assert(
    typeof WebSocket === "function",
    "this Node runtime has no WebSocket client",
  );
  const socket = new WebSocket(url, protocol);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("gateway WebSocket did not open before the deadline"));
    }, 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("gateway WebSocket failed before opening"));
      },
      { once: true },
    );
  });
  return socket;
};

const holdWebSocket = async (socket) => {
  socket.send("printf nehemiah-load-ws\r");
  await Promise.race([
    delay(webSocketHoldMs),
    new Promise((_, reject) => {
      socket.addEventListener(
        "close",
        () =>
          reject(
            new Error("gateway WebSocket closed before the hold completed"),
          ),
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("gateway WebSocket failed during the hold")),
        { once: true },
      );
    }),
  ]);
  assert(
    socket.readyState === WebSocket.OPEN,
    "gateway WebSocket is not open after the hold",
  );
};

const closeWebSocket = async (socket) => {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  socket.close(1000, "load gate complete");
  await Promise.race([closed, delay(5_000)]);
};

const started = performance.now();
let machine;
let socket;
let webSocketHeld = false;
let httpResult;
let admissionResult;
try {
  if (!skipWebSocket) {
    machine = await createMachine();
    machine = await waitForMachine(machine.id);
    const { value: session } = await request(
      `/v1/machines/${encodeURIComponent(machine.id)}/sessions`,
      {
        method: "POST",
        body: {
          capabilities: ["tty"],
          ttl_seconds: Math.min(900, Math.ceil(webSocketHoldMs / 1_000) + 30),
        },
      },
    );
    const gateway = new URL(session.gateway_url);
    gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
    gateway.pathname = `/v1/machines/${encodeURIComponent(machine.id)}/tty`;
    gateway.search = "";
    gateway.hash = "";
    socket = await openWebSocket(
      gateway.href,
      `nehemiah.capability.${session.token}`,
    );
  }
  const operations = [runHttpLoad()];
  if (socket) operations.push(holdWebSocket(socket));
  const [result] = await Promise.all(operations);
  httpResult = result;
  webSocketHeld = Boolean(socket);
} finally {
  await closeWebSocket(socket);
  if (machine?.id) await destroyMachine(machine.id).catch(() => undefined);
}
admissionResult = await verifyRestAdmission();

const { failures, latencies } = httpResult;
latencies.sort((left, right) => left - right);
const percentile = (fraction) =>
  latencies[
    Math.min(latencies.length - 1, Math.floor(fraction * latencies.length))
  ];
const errorRate = failures / requests;
assert(
  errorRate <= maximumErrorRate,
  `error rate ${errorRate} exceeded ${maximumErrorRate}`,
);
report("nehemiah-load", {
  target: new URL(apiUrl()).host,
  requests,
  concurrency,
  duration_ms: Math.round(performance.now() - started),
  error_rate: errorRate,
  p50_ms: Math.round(percentile(0.5)),
  p95_ms: Math.round(percentile(0.95)),
  p99_ms: Math.round(percentile(0.99)),
  websocket_held: webSocketHeld,
  websocket_hold_ms: webSocketHeld ? webSocketHoldMs : 0,
  websocket_skipped_by_explicit_opt_out: skipWebSocket,
  rate_limit_probes: rateLimitProbes,
  rate_limit_rejections: admissionResult.limited,
  rate_limit_unauthorized_before_exhaustion: admissionResult.unauthorized,
  rate_limit_retry_after_seconds: admissionResult.retryAfter,
});
