import {
  apiUrl,
  assert,
  createMachine,
  delay,
  destroyMachine,
  report,
  request,
  waitForMachine,
} from "./common.mjs";

const socketUrl = (session, machineId, capability) => {
  const url = new URL(session.gateway_url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/machines/${encodeURIComponent(machineId)}/${capability}`;
  url.search = "";
  url.hash = "";
  assert(
    !url.href.includes(session.token),
    "capability leaked into WebSocket URL",
  );
  return url.href;
};

const openSocket = async (session, machineId, capability) => {
  assert(
    typeof WebSocket === "function",
    "this Node runtime has no WebSocket client",
  );
  const socket = new WebSocket(
    socketUrl(session, machineId, capability),
    `nehemiah.capability.${session.token}`,
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${capability} WebSocket did not open`));
    }, 15_000);
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
        reject(new Error(`${capability} WebSocket failed before opening`));
      },
      { once: true },
    );
  });
  return socket;
};

const messageText = async (data) => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (data && typeof data.arrayBuffer === "function") {
    return Buffer.from(await data.arrayBuffer()).toString("utf8");
  }
  return "";
};

const waitForSocketText = async (socket, wanted, label) =>
  new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not return ${wanted}`));
    }, 15_000);
    const onMessage = (event) => {
      void messageText(event.data).then(
        (text) => {
          output += text;
          if (output.includes(wanted)) {
            cleanup();
            resolve(output);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} closed before returning the smoke marker`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });

const closeSocket = async (socket) => {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  socket.close(1000, "smoke complete");
  await Promise.race([closed, delay(5_000)]);
};

const gatewayFetch = (session, path, init = {}) => {
  const gatewayBase = new URL(session.gateway_url);
  const gateway = new URL(path, gatewayBase);
  assert(
    gateway.origin === gatewayBase.origin,
    "capability request escaped the issued gateway origin",
  );
  gateway.hash = "";
  return fetch(gateway, {
    ...init,
    redirect: "error",
    headers: {
      authorization: `Bearer ${session.token}`,
      ...init.headers,
    },
  });
};

const waitForFork = async (machineId, idempotencyKey) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await request(
      `/v1/machines/${encodeURIComponent(machineId)}/fork`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: { count: 1 },
        expected: [200, 201, 202],
      },
    );
    if (result.status !== 202) return result.value;
    assert(
      result.value?.operation?.idempotency_key === idempotencyKey,
      "pending fork response did not preserve its idempotency key",
    );
    await delay(500);
  }
  throw new Error("fork did not reach an all-ready terminal response");
};

await request("/healthz", { apiKey: null });
await request("/readyz", { apiKey: null });

let machine;
let fork;
let tty;
let vnc;
try {
  machine = await createMachine({
    template: process.env.NEHEMIAH_SMOKE_TEMPLATE || "desktop",
    vcpus: 2,
    memoryMb: 2_560,
    diskMb: 5_120,
  });
  machine = await waitForMachine(machine.id);
  assert(machine.started_at, "ready machine omitted started_at");
  assert(machine.ready_at, "ready machine omitted ready_at");

  const { value: execution } = await request(
    `/v1/machines/${encodeURIComponent(machine.id)}/exec`,
    {
      method: "POST",
      body: { command: "printf nehemiah-smoke", timeout_seconds: 10 },
    },
  );
  assert(execution.exit_code === 0, `smoke exec exited ${execution.exit_code}`);
  assert(
    execution.stdout === "nehemiah-smoke",
    "smoke exec output was not byte exact",
  );

  const { value: previewServer } = await request(
    `/v1/machines/${encodeURIComponent(machine.id)}/exec`,
    {
      method: "POST",
      body: {
        command:
          'node -e \'require("http").createServer((_,r)=>r.end("nehemiah-preview-smoke")).listen(3000,"0.0.0.0")\' >/tmp/nehemiah-preview.log 2>&1 &',
        timeout_seconds: 10,
      },
    },
  );
  assert(previewServer.exit_code === 0, "preview fixture failed to start");

  const { value: session, headers } = await request(
    `/v1/machines/${encodeURIComponent(machine.id)}/sessions`,
    {
      method: "POST",
      body: { capabilities: ["tty", "vnc", "files"], ttl_seconds: 120 },
    },
  );
  assert(
    headers.get("cache-control") === "no-store",
    "session response was cacheable",
  );
  assert(
    typeof session.token === "string" && session.token.length > 32,
    "session token missing",
  );
  const gateway = new URL(session.gateway_url);
  assert(!gateway.search && !gateway.hash, "gateway URL contained credentials");

  tty = await openSocket(session, machine.id, "tty");
  const ttyOutput = waitForSocketText(tty, "nehemiah-tty-smoke", "TTY");
  tty.send("printf nehemiah-tty-smoke\r");
  await ttyOutput;
  await closeSocket(tty);
  tty = undefined;

  vnc = await openSocket(session, machine.id, "vnc");
  await waitForSocketText(vnc, "RFB ", "VNC");
  await closeSocket(vnc);
  vnc = undefined;

  const filePayload = Buffer.from("nehemiah-file-smoke\n");
  const upload = await gatewayFetch(
    session,
    `/v1/machines/${encodeURIComponent(machine.id)}/upload`,
    {
      method: "POST",
      headers: { "x-filename": "nehemiah-smoke.txt" },
      body: filePayload,
    },
  );
  assert(upload.status === 200, `file upload returned ${upload.status}`);
  const download = await gatewayFetch(
    session,
    `/v1/machines/${encodeURIComponent(machine.id)}/download?path=${encodeURIComponent("/root/nehemiah-smoke.txt")}`,
  );
  assert(download.status === 200, `file download returned ${download.status}`);
  assert(
    Buffer.from(await download.arrayBuffer()).equals(filePayload),
    "file transfer was not byte exact",
  );

  const { value: previewSession } = await request(
    `/v1/machines/${encodeURIComponent(machine.id)}/sessions`,
    {
      method: "POST",
      body: { capabilities: ["preview"], port: 3000, ttl_seconds: 60 },
    },
  );
  const preview = new URL(previewSession.preview_url);
  assert(
    preview.origin !== gateway.origin,
    "preview was not isolated onto an untrusted origin",
  );
  assert(!preview.search, "preview capability leaked through the query string");
  assert(
    preview.hash.startsWith("#token="),
    "preview URL omitted fragment bootstrap token",
  );
  const exchange = await fetch(
    new URL("/v1/capability/exchange", preview.origin),
    {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${previewSession.token}` },
    },
  );
  assert(
    exchange.status === 204,
    `preview exchange returned ${exchange.status}`,
  );
  const previewCookie = exchange.headers.get("set-cookie");
  assert(previewCookie, "preview exchange omitted its HttpOnly cookie");
  preview.hash = "";
  const previewResponse = await fetch(preview, {
    redirect: "error",
    headers: { cookie: previewCookie.split(";", 1)[0] },
  });
  assert(
    previewResponse.status === 200,
    `preview returned ${previewResponse.status}`,
  );
  assert(
    (await previewResponse.text()).includes("nehemiah-preview-smoke"),
    "preview did not reach the guest service",
  );

  const forkKey = `smoke-fork-${machine.id}`;
  fork = await waitForFork(machine.id, forkKey);
  assert(
    fork?.id && fork.id !== machine.id,
    "fork did not return a distinct machine",
  );
  assert(fork.ready === true, "fork terminal response was not ready");
  const replayedFork = await waitForFork(machine.id, forkKey);
  assert(
    replayedFork.id === fork.id,
    "fork idempotency replay returned a different child",
  );

  const { value: extended } = await request(
    `/v1/machines/${encodeURIComponent(machine.id)}/extend`,
    {
      method: "POST",
      headers: { "idempotency-key": `smoke-extend-${machine.id}` },
      body: { ttl_seconds: 600 },
    },
  );
  assert(
    Date.parse(extended.expires_at) >= Date.parse(machine.expires_at),
    "extend shortened the lease",
  );

  report("nehemiah-smoke", {
    target: new URL(apiUrl()).host,
    machine_id: machine.id,
    fork_id: fork.id,
    tty: true,
    vnc: true,
    files: true,
    preview: true,
  });
} finally {
  await closeSocket(vnc).catch(() => undefined);
  await closeSocket(tty).catch(() => undefined);
  if (fork?.id) await destroyMachine(fork.id).catch(() => undefined);
  if (machine?.id) await destroyMachine(machine.id);
}
