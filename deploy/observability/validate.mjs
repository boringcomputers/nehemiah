import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = dirname(fileURLToPath(import.meta.url));
const readYaml = async (path) =>
  YAML.parse(await readFile(join(root, path), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const collectorText = await readFile(join(root, "otel-collector.yaml"), "utf8");
const collector = YAML.parse(collectorText);
assert(
  collector.receivers?.["otlp/private"]?.protocols?.http?.tls,
  "OTLP/HTTP receiver TLS is required",
);
assert(
  collector.receivers["otlp/private"].protocols.http.auth?.authenticator ===
    "basicauth/ingest",
  "OTLP ingest authentication is required",
);
assert(
  String(collector.exporters?.["otlphttp/backend"]?.endpoint).startsWith(
    "https://",
  ),
  "backend OTLP endpoint must force HTTPS",
);
assert(
  collector.exporters["otlphttp/backend"].sending_queue?.storage ===
    "file_storage/queue",
  "backend exporter must use the persistent queue",
);
assert(
  !/insecure\s*:\s*true/.test(collectorText),
  "insecure TLS settings are forbidden",
);
for (const pipeline of ["metrics", "traces"]) {
  const processors = collector.service?.pipelines?.[pipeline]?.processors ?? [];
  assert(
    processors.includes("attributes/redact"),
    `${pipeline} pipeline must redact attributes`,
  );
  assert(
    processors.includes("resource/redact"),
    `${pipeline} pipeline must redact resources`,
  );
  assert(
    processors.includes("transform/allowlist"),
    `${pipeline} pipeline must enforce its allowlist`,
  );
}
for (const required of [
  "authorization",
  "cookie",
  "request\\.body",
  "url\\.",
  "process\\.command",
  "client\\.",
]) {
  assert(
    collectorText.toLowerCase().includes(required),
    `collector redaction is missing ${required}`,
  );
}

const canary = "NEHEMIAH-REDACTION-CANARY-7f91";
const applyDeletePatterns = (attributes) => {
  const result = { ...attributes };
  for (const action of collector.processors["attributes/redact"].actions) {
    if (action.action !== "delete" || !action.pattern) continue;
    let pattern = action.pattern;
    let flags = "";
    if (pattern.startsWith("^(?i:") && pattern.endsWith(")$")) {
      pattern = `^(?:${pattern.slice(5, -2)})$`;
      flags = "i";
    }
    const expression = new RegExp(pattern, flags);
    for (const key of Object.keys(result)) {
      if (expression.test(key)) delete result[key];
    }
  }
  return result;
};
const allowlisted = (attributes, signal) => {
  const groups =
    collector.processors["transform/allowlist"][`${signal}_statements`];
  const context = signal === "trace" ? "span" : "datapoint";
  const statement = groups.find((group) => group.context === context)
    .statements[0];
  const serializedKeys = statement.slice(
    statement.indexOf("["),
    statement.lastIndexOf("]") + 1,
  );
  const allowedKeys = new Set(JSON.parse(serializedKeys));
  return Object.fromEntries(
    Object.entries(applyDeletePatterns(attributes)).filter(([key]) =>
      allowedKeys.has(key),
    ),
  );
};
for (const [signal, attributes] of [
  [
    "trace",
    {
      "http.request.method": "POST",
      "http.route": "/v1/machines/:id",
      "http.request.header.authorization": `Basic ${canary}`,
      "http.request.body": canary,
      "url.full": `https://customer.example/private?token=${canary}`,
      "process.command_args": ["sh", "-c", canary],
      "client.address": "203.0.113.42",
      "unknown.customer_content": canary,
    },
  ],
  [
    "metric",
    {
      result: "success",
      operation: "create",
      cookie: canary,
      "error.message": canary,
      "network.peer.address": "203.0.113.42",
      "unknown.customer_content": canary,
    },
  ],
]) {
  const output = allowlisted(attributes, signal);
  const serialized = JSON.stringify(output);
  assert(
    !serialized.includes(canary),
    `${signal} redaction leaked the canary secret`,
  );
  assert(
    !serialized.includes("203.0.113.42"),
    `${signal} redaction leaked a raw IP`,
  );
  assert(
    !serialized.includes("customer_content"),
    `${signal} allowlist retained an unknown key`,
  );
}

const alerts = await readYaml("prometheus-alerts.yaml");
const rules = (alerts.groups ?? []).flatMap((group) => group.rules ?? []);
assert(rules.length >= 8, "at least eight actionable alert rules are required");
const alertNames = new Set();
for (const rule of rules) {
  assert(
    rule.alert && !alertNames.has(rule.alert),
    `duplicate or missing alert name: ${rule.alert}`,
  );
  alertNames.add(rule.alert);
  assert(
    rule.expr && rule.for,
    `${rule.alert} must have an expression and hold duration`,
  );
  assert(
    rule.labels?.owner && rule.labels?.severity,
    `${rule.alert} must name owner and severity`,
  );
  assert(
    rule.annotations?.dashboard && rule.annotations?.runbook,
    `${rule.alert} must link dashboard and runbook`,
  );
  assert(
    !/(authorization|cookie|query|body|command|client_ip|url_full)/i.test(
      String(rule.expr),
    ),
    `${rule.alert} uses a forbidden label`,
  );
}

const datasource = await readYaml(
  "grafana/provisioning/datasources/datasources.yaml",
);
assert(
  datasource.datasources?.[0]?.uid === "nehemiah-prometheus",
  "Grafana datasource UID is unstable",
);
const provider = await readYaml(
  "grafana/provisioning/dashboards/dashboards.yaml",
);
assert(
  provider.providers?.[0]?.allowUiUpdates === false,
  "dashboards must remain code-owned",
);

const dashboardDirectory = join(root, "grafana/dashboards");
const dashboardFiles = (await readdir(dashboardDirectory)).filter((name) =>
  name.endsWith(".json"),
);
assert(dashboardFiles.length >= 5, "five versioned dashboards are required");
const dashboardUIDs = new Set();
for (const name of dashboardFiles) {
  assert(
    /-v\d+\.json$/.test(name),
    `dashboard filename is not versioned: ${name}`,
  );
  const dashboard = JSON.parse(
    await readFile(join(dashboardDirectory, name), "utf8"),
  );
  assert(
    dashboard.uid && !dashboardUIDs.has(dashboard.uid),
    `duplicate or missing dashboard UID: ${name}`,
  );
  dashboardUIDs.add(dashboard.uid);
  assert(
    Number.isInteger(dashboard.version) && dashboard.version >= 1,
    `dashboard version missing: ${name}`,
  );
  assert(
    Array.isArray(dashboard.panels) && dashboard.panels.length >= 3,
    `dashboard panels missing: ${name}`,
  );
  const serialized = JSON.stringify(dashboard);
  assert(
    !/(authorization|cookie|query|body|command|client_ip|url_full)/i.test(
      serialized,
    ),
    `dashboard uses forbidden telemetry: ${name}`,
  );
}

process.stdout.write(
  `validated collector, ${rules.length} alerts, and ${dashboardFiles.length} dashboards\n`,
);
