#!/usr/bin/env node
// MCP server for Nehemiah. Lets any MCP client (Claude Desktop, Cursor,
// etc.) spin up and drive a real Linux computer: run tasks, take screenshots,
// fork it, expose ports. Talks to YOUR nehemiahd (self-hosted; no public endpoint).
//
//   NEHEMIAH_URL=http://localhost:8080 node index.mjs
//   (NEHEMIAH_URL defaults to http://localhost:8080; legacy BORING_URL still works)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { make } from "nehemiah-sdk";

const BASE =
  process.env.NEHEMIAH_URL || process.env.BORING_URL || "http://localhost:8080";
const WSBASE = BASE.replace(/^http/, "ws");
const PREVIEW_HOST = new URL(BASE).host;

// The MCP protocol layer is Promise-based; machine ops go through the Effect SDK,
// run to a Promise at this boundary.
const nehemiah = make({ baseUrl: BASE });
const run = (effect) => Effect.runPromise(effect);

// Run a natural-language task via the terminal agent, collecting its narration.
function runTask(id, goal) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `${WSBASE}/v1/machines/${id}/shell-agent?goal=${encodeURIComponent(goal)}`,
    );
    const log = [];
    let preview = null;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ log, preview, note: "timed out" });
    }, 180000);
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "preview") preview = m.text;
      else if (m.type === "action") log.push("$ " + m.text);
      else if (m.type === "say" || m.type === "done") log.push(m.text);
      if (m.type === "done" || m.type === "error") {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve({ log: log.filter(Boolean), preview });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ log, preview, note: "connection error" });
    };
  });
}

const TOOLS = [
  {
    name: "launch_computer",
    description:
      'Boot a fresh computer (a Firecracker microVM). "desktop" = a full Linux GUI with a browser + coding agents; "python" = a fast headless shell; or the name of a template you made with publish_computer (boots your saved setup in milliseconds). Returns the machine id you pass to the other tools.',
    inputSchema: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: '"desktop", "python", or a published template name',
          default: "desktop",
        },
        internet: {
          type: "boolean",
          description: "give the shell internet (desktops always have it)",
          default: true,
        },
        volume: {
          type: "string",
          description: "optional volume id to restore into /root on boot",
        },
        ttl_seconds: {
          type: "number",
          description: "auto-destroy after this many seconds (15–900)",
          default: 600,
        },
      },
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
          type: "number",
          description: "new TTL from now (default 600, clamped 15–900)",
          default: 600,
        },
      },
      required: ["id"],
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
          type: "number",
          description: "how many clones (default 1, max 8)",
          default: 1,
        },
      },
      required: ["id"],
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
];

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

async function dispatch(name, a) {
  switch (name) {
    case "launch_computer": {
      const m = await run(
        nehemiah.createMachine({
          template: a.template || "desktop",
          net: a.internet !== false,
          ttlSeconds: a.ttl_seconds || 600,
          volume: a.volume || undefined,
        }),
      );
      return text(
        `Launched ${m.template} computer ${m.id} (${m.mode}, ${m.boot_ms}ms). It self-destructs at ${m.expires_at}. Use run_task with id "${m.id}".`,
      );
    }
    case "create_volume": {
      const v = await run(nehemiah.createVolume(a.ttl_seconds || undefined));
      return text(
        `Created volume ${v.id} (${v.quota_mb}MB). Save a computer into it with save_computer, then restore it by passing volume "${v.id}" to launch_computer.`,
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
      const res = await fetch(`${BASE}/v1/machines/${a.id}/screenshot`);
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
    case "preview_url":
      return text(`https://${a.id}--${a.port}.${PREVIEW_HOST}/`);
    case "extend_computer": {
      const m = await run(nehemiah.extendMachine(a.id, a.ttl_seconds || 600));
      return text(`Extended ${m.id} — now self-destructs at ${m.expires_at}.`);
    }
    case "fork_computer": {
      const n = Math.max(1, a.count || 1);
      const forks = await run(nehemiah.branchMachines(a.id, n));
      if (forks.length === 1) {
        const f = forks[0];
        return text(
          `Forked → ${f.id} (${f.mode}, ${f.boot_ms}ms). A live clone of ${a.id}.`,
        );
      }
      const lines = forks.map((f) => `  ${f.id} (${f.boot_ms}ms)`).join("\n");
      return text(
        `Forked ${a.id} → ${forks.length} clones from one snapshot:\n${lines}${forks.length < n ? `\n(${n - forks.length} of ${n} didn't fit — capacity limits)` : ""}`,
      );
    }
    case "publish_computer": {
      const t = await run(nehemiah.publishMachine(a.id, a.name));
      return text(
        `Published ${a.id} as template "${t.name}" (${t.size_mb ?? "?"}MB). Launch it any time: launch_computer with template "${t.name}" — boots your exact setup in milliseconds.`,
      );
    }
    case "list_templates": {
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
  { name: "nehemiah", version: "0.1.0" },
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
      content: [{ type: "text", text: "Error: " + (e?.message || String(e)) }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
console.error("Nehemiah MCP server ready (endpoint: " + BASE + ")");
