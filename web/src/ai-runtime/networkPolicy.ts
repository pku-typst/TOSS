import type { NormalizedAiEndpoint } from "@/features/ai/runtimePolicy";

const ALLOWED_METHODS = new Set(["GET", "POST"]);

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

export function isBoundAiRuntimeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  endpoint: NormalizedAiEndpoint
) {
  const target = requestUrl(input);
  const base = new URL(endpoint.baseUrl);
  if (target.username || target.password || target.origin !== endpoint.origin) return false;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const insideBasePath = target.pathname === base.pathname || target.pathname.startsWith(basePath);
  return insideBasePath && ALLOWED_METHODS.has(requestMethod(input, init));
}

export function installBoundAiRuntimeFetch(endpoint: NormalizedAiEndpoint) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const boundFetch: typeof fetch = (input, init) => {
    if (!isBoundAiRuntimeRequest(input, init, endpoint)) {
      return Promise.reject(new Error("ai_runtime_request_outside_connection"));
    }
    return nativeFetch(input, {
      ...init,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "cors",
      cache: "no-store",
      keepalive: false
    });
  };
  globalThis.fetch = boundFetch;
}
