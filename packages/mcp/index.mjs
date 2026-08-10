#!/usr/bin/env node
// MCP server for Nehemiah. Lets any MCP client (Claude Desktop, Cursor,
// etc.) spin up and drive a real Linux computer: run tasks, take screenshots,
// fork it, expose ports. Supports Boring Computers Cloud and local nehemiahd.
//
//   NEHEMIAH_API_KEY=bc_... NEHEMIAH_PROJECT=... node index.mjs
//   NEHEMIAH_URL=http://localhost:8080 node index.mjs
// With an API key the endpoint defaults to Cloud; otherwise it defaults local.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Either } from "effect";
import { make, NotSupported } from "nehemiah-sdk";
import { pathToFileURL } from "node:url";
import { toolAvailable } from "./catalog.mjs";
import { configFromEnv, redactSecrets, safeEndpoint } from "./config.mjs";
import {
  boundedInteger,
  OperationRecovery,
  requiredIdempotencyKey,
  withOperationRecovery,
} from "./operation.mjs";
import { agentSocketTarget } from "./websocket.mjs";

const CONFIG = configFromEnv();
const BASE = CONFIG.baseUrl.replace(/\/+$/, "");
const PREVIEW_HOST = new URL(BASE).host;

// The MCP protocol layer is Promise-based; machine ops go through the Effect SDK,
// run to a Promise at this boundary.
const nehemiah = make(CONFIG);
const run = async (effect) => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

// Run a natural-language task via the terminal agent, collecting its narration.
async function runTask(id, goal) {
  if (nehemiah.target === "cloud") {
    throw new NotSupported({
      operation: "run_task",
      target: "cloud",
      detail:
        "Managed host-local LLM agents are disabled until inference credentials and cost admission are centrally brokered. Use run_command or an agent running inside the guest.",
    });
  }
  let socketTarget;
  if (nehemiah.target === "cloud") {
    const session = await run(
      nehemiah.createSession(id, { capabilities: ["agent"] }),
    );
    socketTarget = agentSocketTarget({
      target: "cloud",
      baseUrl: BASE,
      gatewayUrl: session.gatewayUrl,
      machineId: id,
      goal,
      capabilityToken: session.token,
    });
  } else {
    socketTarget = agentSocketTarget({
      target: "local",
      baseUrl: BASE,
      gatewayUrl: BASE,
      machineId: id,
      goal,
      apiKey: CONFIG.apiKey,
    });
  }
  const result = await new Promise((resolve) => {
    const ws = socketTarget.protocol
      ? new WebSocket(socketTarget.url, socketTarget.protocol)
      : new WebSocket(socketTarget.url);
    const log = [];
    let previewPort = null;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ log, previewPort, note: "timed out" });
    }, 180000);
    ws.onopen = () => {
      try {
        ws.send(socketTarget.initialMessage);
      } catch {
        clearTimeout(timer);
        resolve({ log, previewPort, note: "connection error" });
      }
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "preview") {
        const port = Number(m.port ?? m.text);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          previewPort = port;
        }
      } else if (m.type === "action") log.push("$ " + m.text);
      else if (m.type === "say" || m.type === "done") log.push(m.text);
      if (m.type === "done" || m.type === "error") {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve({ log: log.filter(Boolean), previewPort });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ log, previewPort, note: "connection error" });
    };
  });
  let preview = null;
  if (result.previewPort !== null) {
    preview =
      nehemiah.target === "cloud"
        ? await run(nehemiah.getPreviewUrl(id, result.previewPort))
        : `https://${id}--${result.previewPort}.${PREVIEW_HOST}/`;
  }
  return { log: result.log, preview, note: result.note };
}

export const TOOLS = [
  {
    name: "launch_computer",
    description:
      'Boot a fresh computer (a Firecracker microVM). Managed cloud supports the built-in "desktop" and "python" templates plus an explicitly reviewed template_id. Returns the machine id used by other tools.',
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: 'built-in template name: "desktop" or "python"',
          default: "desktop",
        },
        ...(CONFIG.target === "cloud"
          ? {
              template_id: {
                type: "string",
                description:
                  "managed immutable-template UUID; mutually exclusive with a non-default template",
              },
            }
          : {}),
        ...(CONFIG.target === "cloud"
          ? {}
          : {
              internet: {
                type: "boolean",
                description: "enable the legacy local/self-hosted NIC",
                default: false,
              },
            }),
        ...(CONFIG.target === "cloud"
          ? {
              allowed_hostnames: {
                type: "array",
                maxItems: 0,
                items: { type: "string" },
                description:
                  "reserved; hostname egress is disabled until every connection can be name-bound",
              },
              allowed_cidrs: {
                type: "array",
                maxItems: 0,
                items: { type: "string" },
                description:
                  "reserved; managed egress is disabled until aggregate traffic quotas exist",
              },
            }
          : {}),
        ...(CONFIG.target === "cloud"
          ? {}
          : {
              volume: {
                type: "string",
                description: "optional volume id to restore into /root on boot",
              },
            }),
        ...(CONFIG.target === "cloud"
          ? {
              region: {
                type: "string",
                description:
                  "managed-cloud region (defaults to client configuration)",
              },
              size: {
                type: "string",
                enum: ["small", "medium", "large"],
                description: "managed-cloud resource preset",
              },
            }
          : {}),
        ttl_seconds: {
          type: "integer",
          minimum: 15,
          maximum: 86400,
          description: "auto-destroy after this many seconds (15–86,400)",
          default: 600,
        },
        ...(CONFIG.target === "cloud"
          ? {
              idempotency_key: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z0-9._:-]+$",
                description:
                  "caller-owned operation key; reuse unchanged after any timeout or pending result",
              },
            }
          : {}),
      },
      required: CONFIG.target === "cloud" ? ["idempotency_key"] : [],
    },
  },
  {
    name: "run_command",
    description:
      "Run one shell command in the computer and get its output and exit code back — deterministic, no agent in the loop. Use this to drive the machine yourself; use run_task only when you want an agent to figure out the steps.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        command: { type: "string", description: "the shell command to run" },
        timeout_seconds: {
          type: "number",
          description: "give up after this long (default 30, max 120)",
        },
      },
      required: ["id", "command"],
    },
  },
  {
    name: "run_task",
    description:
      "Give the computer a natural-language task; an agent writes and runs commands to do it (installing packages, building + serving apps, etc.). If it starts a web server it returns a live preview URL.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        task: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: 'e.g. "build a snake game in python and serve it"',
        },
      },
      required: ["id", "task"],
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of a desktop computer.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "preview_url",
    description:
      "Get the public HTTPS URL for a port running inside a computer.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, port: { type: "number" } },
      required: ["id", "port"],
    },
  },
  {
    name: "extend_computer",
    description:
      "Reset a computer's self-destruct timer (e.g. when a task needs more time). Returns the new expiry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        ttl_seconds: {
          type: "integer",
          minimum: 15,
          maximum: 86400,
          description: "new TTL from now (default 600, range 15–86,400)",
          default: 600,
        },
        ...(CONFIG.target === "cloud"
          ? {
              idempotency_key: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z0-9._:-]+$",
              },
            }
          : {}),
      },
      required: CONFIG.target === "cloud" ? ["id", "idempotency_key"] : ["id"],
    },
  },
  {
    name: "fork_computer",
    description:
      "Clone a running computer (its exact live state). count > 1 makes N clones from one snapshot — try a different approach in each, keep the winner.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "how many clones (default 1, max 8)",
          default: 1,
        },
        ...(CONFIG.target === "cloud"
          ? {
              idempotency_key: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z0-9._:-]+$",
                description:
                  "reuse this exact key while a fork batch is pending",
              },
            }
          : {}),
      },
      required: CONFIG.target === "cloud" ? ["id", "idempotency_key"] : ["id"],
    },
  },
  {
    name: "publish_computer",
    description:
      "Freeze a computer's current state as a named template — future launch_computer calls with that name boot your exact setup (installed packages, files, everything) in milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: {
          type: "string",
          description: "template name: lowercase letters, digits, dashes",
        },
      },
      required: ["id", "name"],
    },
  },
  {
    name: "list_templates",
    description:
      "List available templates: the built-ins plus everything published.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_computers",
    description: "List the currently running computers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_computer",
    description: "Destroy a computer now.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "create_volume",
    description:
      "Create a persistent volume — storage that outlives a computer. Save a computer into it, then restore it into a fresh computer later (pass its id as launch_computer volume).",
    inputSchema: {
      type: "object",
      properties: {
        ttl_seconds: {
          type: "number",
          description: "how long the volume lives",
        },
      },
      required: [],
    },
  },
  {
    name: "save_computer",
    description:
      "Save a computer's /root into a volume, so its work survives the self-destruct.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, volume: { type: "string" } },
      required: ["id", "volume"],
    },
  },
].filter((tool) => toolAvailable(CONFIG.target, tool.name));

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

export async function dispatch(name, a) {
  switch (name) {
    case "launch_computer": {
      const idempotencyKey =
        nehemiah.target === "cloud" ? requiredIdempotencyKey(a) : undefined;
      const createOptions = {
        template: a.template || "desktop",
        ttlSeconds: boundedInteger(
          a.ttl_seconds,
          600,
          15,
          86400,
          "ttl_seconds",
        ),
        project: CONFIG.project,
        region: a.region || CONFIG.region,
        size: a.size || undefined,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      if (nehemiah.target !== "cloud") {
        if (
          a.template_id !== undefined ||
          a.region !== undefined ||
          a.size !== undefined ||
          a.allowed_hostnames !== undefined ||
          a.allowed_cidrs !== undefined ||
          a.idempotency_key !== undefined
        ) {
          throw new NotSupported({
            operation: "launch_computer managed options",
            target: nehemiah.target,
            detail:
              "template_id, region, size, managed network policy, and durable idempotency require the cloud target.",
          });
        }
        delete createOptions.project;
        delete createOptions.region;
        delete createOptions.size;
        createOptions.net = a.internet === true;
        createOptions.volume = a.volume || undefined;
      } else {
        if (a.internet === true || a.volume !== undefined) {
          throw new Error(
            "legacy internet and volume options are unavailable on the managed cloud target",
          );
        }
        if (a.template_id && a.template && a.template !== "desktop") {
          throw new Error(
            "template_id cannot be combined with a custom template name",
          );
        }
        if (
          !a.template_id &&
          !["desktop", "python"].includes(createOptions.template)
        ) {
          throw new Error(
            "managed cloud accepts only built-in template names or template_id",
          );
        }
        if (a.template_id) {
          createOptions.templateId = a.template_id;
          delete createOptions.template;
        }
        const hostnames = Array.isArray(a.allowed_hostnames)
          ? a.allowed_hostnames
          : [];
        const cidrs = Array.isArray(a.allowed_cidrs) ? a.allowed_cidrs : [];
        if (hostnames.length > 0 || cidrs.length > 0) {
          throw new Error(
            "managed guest egress is disabled until hard organization, project, and host-network traffic quotas are enforced",
          );
        }
        createOptions.networkPolicy = { mode: "off", hostnames: [], cidrs: [] };
      }
      const operation = () => run(nehemiah.createMachine(createOptions));
      const m = idempotencyKey
        ? await withOperationRecovery(operation, idempotencyKey)
        : await operation();
      return text(
        `Launched ${m.template || m.template_id || "machine"} computer ${m.id}${m.mode ? ` (${m.mode}${m.boot_ms !== undefined ? `, ${m.boot_ms}ms` : ""})` : ""}. State: ${m.status}${m.ready === false ? " (starting)" : ""}. It self-destructs at ${m.expires_at}. ${nehemiah.target === "cloud" ? `Use run_command with id "${m.id}" or run your own agent inside the guest.` : `Use run_task with id "${m.id}".`}`,
      );
    }
    case "create_volume": {
      if (a.idempotency_key !== undefined) {
        throw new NotSupported({
          operation: "create_volume idempotency",
          target: nehemiah.target,
          detail:
            "The public local/self-hosted volume route does not provide durable idempotency replay.",
        });
      }
      const v = await run(
        nehemiah.createVolume({ ttlSeconds: a.ttl_seconds || undefined }),
      );
      return text(
        nehemiah.target === "cloud"
          ? `Created durable volume metadata ${v.id} (${v.quota_mb}MB). Managed machine attach/save is not yet supported; use the bounded upload/download API for object data.`
          : `Created volume ${v.id} (${v.quota_mb}MB). Save a computer into it with save_computer, then restore it by passing volume "${v.id}" to launch_computer.`,
      );
    }
    case "save_computer": {
      await run(nehemiah.saveMachine(a.id, a.volume));
      return text(
        `Saved ${a.id} into volume ${a.volume}. Launch a new computer with that volume to restore it.`,
      );
    }
    case "run_command": {
      const r = await run(
        nehemiah.exec(
          a.id,
          a.command,
          a.timeout_seconds ? { timeoutSeconds: a.timeout_seconds } : undefined,
        ),
      );
      if (r.timed_out)
        return text(
          `(timed out after ${r.duration_ms}ms — still running in the machine)\n${r.output}`,
        );
      return text(`exit ${r.exit_code} (${r.duration_ms}ms)\n${r.output}`);
    }
    case "run_task": {
      const { log, preview, note } = await runTask(a.id, a.task);
      let out = log.join("\n") || "(no output)";
      if (preview) out += `\n\nLive preview: ${preview}`;
      if (note) out += `\n(${note})`;
      return text(out);
    }
    case "screenshot": {
      if (nehemiah.target === "cloud") {
        throw new NotSupported({
          operation: "screenshot",
          target: "cloud",
          detail:
            "The managed gateway does not currently expose a screenshot route; use the VNC/desktop session instead.",
        });
      }
      const res = await fetch(
        `${BASE}/v1/machines/${encodeURIComponent(a.id)}/screenshot`,
        CONFIG.apiKey
          ? { headers: { authorization: `Bearer ${CONFIG.apiKey}` } }
          : undefined,
      );
      if (!res.ok) throw new Error(`screenshot failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          {
            type: "image",
            data: buf.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    }
    case "preview_url": {
      if (nehemiah.target === "cloud") {
        return text(await run(nehemiah.getPreviewUrl(a.id, a.port)));
      }
      return text(`https://${a.id}--${a.port}.${PREVIEW_HOST}/`);
    }
    case "extend_computer": {
      const idempotencyKey =
        nehemiah.target === "cloud" ? requiredIdempotencyKey(a) : undefined;
      if (nehemiah.target !== "cloud" && a.idempotency_key !== undefined) {
        throw new NotSupported({
          operation: "extend_computer idempotency",
          target: nehemiah.target,
          detail:
            "The public local/self-hosted extend route does not provide durable idempotency replay.",
        });
      }
      const operation = () =>
        run(
          nehemiah.extendMachine(
            a.id,
            boundedInteger(a.ttl_seconds, 600, 15, 86400, "ttl_seconds"),
            idempotencyKey === undefined ? {} : { idempotencyKey },
          ),
        );
      const m = idempotencyKey
        ? await withOperationRecovery(operation, idempotencyKey)
        : await operation();
      return text(`Extended ${m.id} — now self-destructs at ${m.expires_at}.`);
    }
    case "fork_computer": {
      const idempotencyKey =
        nehemiah.target === "cloud" ? requiredIdempotencyKey(a) : undefined;
      if (nehemiah.target !== "cloud" && a.idempotency_key !== undefined) {
        throw new NotSupported({
          operation: "fork_computer idempotency",
          target: nehemiah.target,
          detail:
            "The public local/self-hosted branch route does not provide durable idempotency replay.",
        });
      }
      const n = boundedInteger(a.count, 1, 1, 8, "count");
      const operation = () =>
        run(
          nehemiah.branchMachines(
            a.id,
            n,
            idempotencyKey === undefined ? {} : { idempotencyKey },
          ),
        );
      const forks = idempotencyKey
        ? await withOperationRecovery(operation, idempotencyKey)
        : await operation();
      if (forks.length === 1) {
        const f = forks[0];
        return text(
          `Forked → ${f.id}${f.mode ? ` (${f.mode}${f.boot_ms !== undefined ? `, ${f.boot_ms}ms` : ""})` : ""}. A live clone of ${a.id}.`,
        );
      }
      const lines = forks
        .map(
          (f) =>
            `  ${f.id}${f.boot_ms !== undefined ? ` (${f.boot_ms}ms)` : ""}`,
        )
        .join("\n");
      return text(
        `Forked ${a.id} → ${forks.length} clones from one snapshot:\n${lines}${forks.length < n ? `\n(${n - forks.length} of ${n} didn't fit — capacity limits)` : ""}`,
      );
    }
    case "publish_computer": {
      if (nehemiah.target === "cloud") {
        throw new NotSupported({
          operation: "publish_computer",
          target: "cloud",
          detail:
            "Managed custom-template publication is disabled for the private beta.",
        });
      }
      const t = await run(nehemiah.publishMachine(a.id, a.name));
      return text(
        `Published ${a.id} as template "${t.name}" (${t.size_mb ?? "?"}MB). Launch it any time: launch_computer with template "${t.name}" — boots your exact setup in milliseconds.`,
      );
    }
    case "list_templates": {
      if (nehemiah.target === "cloud") {
        const ts = await run(nehemiah.listManagedTemplates());
        return text(
          [
            "desktop — built-in",
            "python — built-in",
            ...ts.map(
              (t) => `${t.name}@${t.version} — ${t.id} (${t.size_bytes} bytes)`,
            ),
          ].join("\n"),
        );
      }
      const ts = await run(nehemiah.listTemplates);
      return text(
        ts
          .map(
            (t) =>
              `${t.name}${t.published ? ` — published${t.size_mb ? `, ${t.size_mb}MB` : ""}${t.source_template ? `, from ${t.source_template}` : ""}` : " — built-in"}${t.display ? " (desktop)" : ""}`,
          )
          .join("\n"),
      );
    }
    case "list_computers": {
      const arr = await run(nehemiah.listMachines);
      return text(
        arr.length ? JSON.stringify(arr, null, 2) : "No computers running.",
      );
    }
    case "stop_computer":
      await run(nehemiah.destroyMachine(a.id));
      return text(`Stopped ${a.id}.`);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const server = new Server(
  { name: "nehemiah", version: "0.2.0-beta.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await dispatch(req.params.name, req.params.arguments || {});
  } catch (e) {
    return {
      content: [{ type: "text", text: "Error: " + safeErrorMessage(e) }],
      isError: true,
    };
  }
});

export function safeErrorMessage(error) {
  if (error instanceof OperationRecovery) {
    return `${safeErrorMessage(error.cause)} Retry the unchanged operation with idempotency_key "${error.idempotencyKey}".`;
  }
  if (error?._tag === "NotSupported") return error.detail;
  if (error?._tag === "ResponseError") {
    return error.problem?.detail || `API request failed (${error.status})`;
  }
  if (error?._tag === "RequestError") {
    return `Request failed: ${error.method} ${error.path}`;
  }
  return redactSecrets(error?.message || String(error));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await server.connect(new StdioServerTransport());
  // Endpoint-only diagnostic: never print API keys, capability URLs, or auth headers.
  console.error(
    "Nehemiah MCP server ready (endpoint: " + safeEndpoint(BASE) + ")",
  );
}
