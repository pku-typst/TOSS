import type { AiRuntimeConnection } from "@/features/ai/protocol";
import type { AiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";

export type NormalizedAiEndpoint = {
  baseUrl: string;
  origin: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function normalizeAiRuntimeEndpoint(
  rawBaseUrl: string,
  applicationOrigin: string
): NormalizedAiEndpoint {
  if (rawBaseUrl.length === 0 || rawBaseUrl.length > 2_048) {
    throw new Error("ai_endpoint_invalid_length");
  }
  const endpoint = new URL(rawBaseUrl);
  const app = new URL(applicationOrigin);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("ai_endpoint_contains_credentials_or_parameters");
  }
  const secure = endpoint.protocol === "https:";
  const loopback = endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname);
  if (!secure && !loopback) throw new Error("ai_endpoint_scheme_not_allowed");
  if (endpoint.origin === app.origin) throw new Error("ai_endpoint_matches_application_origin");
  return {
    baseUrl: endpoint.href,
    origin: endpoint.origin
  };
}

export function runtimeConnectSource(
  connection: AiRuntimeConnection,
  applicationOrigin: string,
  policy: AiRuntimeServerPolicy
) {
  if (connection.kind === "fake") return { source: "'none'", endpoint: null };
  if (policy.kind === "managed_catalog") {
    if (connection.kind !== "managed") throw new Error("ai_runtime_managed_connection_required");
    const endpoint = normalizeAiRuntimeEndpoint(policy.provider.baseUrl, applicationOrigin);
    return { source: endpoint.origin, endpoint };
  }
  if (connection.kind !== "endpoint") throw new Error("ai_runtime_user_connection_required");
  const endpoint = normalizeAiRuntimeEndpoint(connection.baseUrl, applicationOrigin);
  return { source: endpoint.origin, endpoint };
}

export function installRuntimeMetaPolicy(content: string) {
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = content;
  document.head.prepend(policy);
  return policy;
}

export function earlyRuntimePolicy(connectSource: string) {
  return `connect-src ${connectSource}`;
}

export function lockedRuntimePolicy(connectSource: string) {
  return [
    "script-src 'none'",
    "worker-src 'none'",
    `connect-src ${connectSource}`,
    "img-src 'none'",
    "font-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}
