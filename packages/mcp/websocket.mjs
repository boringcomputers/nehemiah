const websocketBase = (value) =>
  value.replace(/^http/, "ws").replace(/\/+$/, "");

const startFrame = (goal) => {
  if (typeof goal !== "string") throw new Error("a task goal is required");
  const normalized = goal.trim();
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes < 1 || bytes > 4096) {
    throw new Error(
      "the task goal must contain between 1 and 4096 UTF-8 bytes",
    );
  }
  return JSON.stringify({ type: "start", version: 1, goal: normalized });
};

const managedSocketUrl = (gatewayUrl, machineId) => {
  const gateway = new URL(gatewayUrl);
  if (
    gateway.protocol !== "https:" ||
    gateway.username !== "" ||
    gateway.password !== "" ||
    gateway.search !== "" ||
    gateway.hash !== "" ||
    (gateway.pathname !== "" && gateway.pathname !== "/")
  ) {
    throw new Error("the managed gateway must be a bare HTTPS origin");
  }
  const url = new URL(
    `/v1/machines/${encodeURIComponent(machineId)}/shell-agent`,
    gateway.origin,
  );
  url.protocol = "wss:";
  return url;
};

export function agentSocketTarget({
  target,
  baseUrl,
  gatewayUrl,
  machineId,
  goal,
  apiKey,
  capabilityToken,
}) {
  const initialMessage = startFrame(goal);
  const url =
    target === "cloud"
      ? managedSocketUrl(gatewayUrl, machineId)
      : new URL(
          `${websocketBase(baseUrl)}/v1/machines/${encodeURIComponent(machineId)}/shell-agent`,
        );

  if (target === "cloud") {
    if (
      typeof capabilityToken !== "string" ||
      !/^[A-Za-z0-9._~-]{1,4096}$/.test(capabilityToken)
    ) {
      throw new Error("a valid agent capability token is required");
    }
    return {
      url: url.toString(),
      protocol: `nehemiah.capability.${capabilityToken}`,
      initialMessage,
    };
  }

  // The self-hosted daemon retains its legacy query-token contract. Managed
  // capabilities must never use this branch because URLs reach histories and
  // edge access logs.
  if (apiKey) url.searchParams.set("token", apiKey);
  return { url: url.toString(), initialMessage };
}
