import { CLOUD_BASE_URL, LOCAL_BASE_URL } from "nehemiah-sdk";

/** Resolve MCP configuration without ever copying credentials into loggable URLs. */
export function configFromEnv(env = process.env) {
  const apiKey = env.NEHEMIAH_API_KEY || env.NEHEMIAH_TOKEN;
  const explicitUrl = env.NEHEMIAH_URL || env.BORING_URL;
  const explicitTarget = ["local", "self-hosted", "cloud"].includes(
    env.NEHEMIAH_TARGET,
  )
    ? env.NEHEMIAH_TARGET
    : undefined;
  const target =
    explicitTarget ||
    (apiKey || env.NEHEMIAH_PROJECT || explicitUrl === CLOUD_BASE_URL
      ? "cloud"
      : "local");
  const baseUrl =
    explicitUrl || (target === "cloud" ? CLOUD_BASE_URL : LOCAL_BASE_URL);
  return {
    target,
    baseUrl,
    apiKey,
    project: env.NEHEMIAH_PROJECT || undefined,
    region: env.NEHEMIAH_REGION || undefined,
  };
}

export function safeEndpoint(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "configured endpoint";
  }
}

export function redactSecrets(value) {
  return String(value)
    .replace(/([?&]token=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,}]+/gi, "$1<redacted>")
    .replace(/\bbc_[A-Za-z0-9._-]+\b/g, "bc_<redacted>");
}
