import { randomUUID } from "node:crypto";

export const required = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const positiveInteger = (
  name,
  fallback,
  maximum = Number.MAX_SAFE_INTEGER,
) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
};

export const apiUrl = () => {
  const raw = required("NEHEMIAH_TEST_URL", process.env.NEHEMIAH_URL);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NEHEMIAH_TEST_URL must be an absolute HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NEHEMIAH_TEST_URL must be an absolute HTTP(S) origin");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    parsed.protocol !== "https:" &&
    !loopback &&
    process.env.NEHEMIAH_TEST_ALLOW_INSECURE !== "1"
  ) {
    throw new Error(
      "NEHEMIAH_TEST_URL must use HTTPS outside loopback (or explicitly set NEHEMIAH_TEST_ALLOW_INSECURE=1)",
    );
  }
  return parsed.origin;
};

export class ApiError extends Error {
  constructor(method, path, status, detail) {
    super(`${method} ${path} returned ${status}: ${detail}`);
    this.status = status;
  }
}

export const request = async (
  path,
  {
    baseUrl = apiUrl(),
    apiKey = process.env.NEHEMIAH_TEST_API_KEY || process.env.NEHEMIAH_API_KEY,
    method = "GET",
    body,
    headers = {},
    expected = [200],
    signal,
  } = {},
) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal,
    redirect: "error",
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  if (!expected.includes(response.status)) {
    const detail =
      typeof value === "object" && value !== null && "detail" in value
        ? String(value.detail)
        : String(value || response.statusText);
    throw new ApiError(method, path, response.status, detail.slice(0, 512));
  }
  return { status: response.status, headers: response.headers, value };
};

export const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForMachine = async (
  id,
  {
    apiKey,
    terminal = ["failed", "lost", "stopped"],
    deadline = Date.now() +
      positiveInteger("NEHEMIAH_TEST_READY_TIMEOUT_MS", 120_000, 600_000),
  } = {},
) => {
  while (Date.now() < deadline) {
    const { value: machine } = await request(
      `/v1/machines/${encodeURIComponent(id)}`,
      {
        apiKey,
      },
    );
    if (machine.ready) return machine;
    if (terminal.includes(machine.state))
      throw new Error(`${id} entered ${machine.state}`);
    await delay(500);
  }
  throw new Error(`${id} did not become ready before the deadline`);
};

export const createMachine = async ({
  apiKey,
  projectId,
  idempotencyKey,
  template,
  vcpus,
  memoryMb,
  diskMb,
} = {}) => {
  const key = idempotencyKey || `staging-${randomUUID()}`;
  const { value } = await request("/v1/machines", {
    apiKey,
    method: "POST",
    headers: { "idempotency-key": key },
    body: {
      project_id:
        projectId ||
        required("NEHEMIAH_TEST_PROJECT_ID", process.env.NEHEMIAH_PROJECT),
      template: template || process.env.NEHEMIAH_TEST_TEMPLATE || "python",
      ttl_seconds: positiveInteger("NEHEMIAH_TEST_TTL_SECONDS", 300, 86_400),
      ...(vcpus === undefined ? {} : { vcpus }),
      ...(memoryMb === undefined ? {} : { memory_mb: memoryMb }),
      ...(diskMb === undefined ? {} : { disk_mb: diskMb }),
    },
    expected: [201, 202],
  });
  return value;
};

export const destroyMachine = async (id, apiKey) => {
  await request(`/v1/machines/${encodeURIComponent(id)}`, {
    apiKey,
    method: "DELETE",
    expected: [204],
  });
};

export const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const report = (name, fields = {}) => {
  process.stdout.write(
    `${JSON.stringify({ check: name, ok: true, ...fields })}\n`,
  );
};
