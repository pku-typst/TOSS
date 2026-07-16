import type { NormalizedAiEndpoint } from "@/features/ai/runtimePolicy";
import type { AiRuntimeManagedProvider } from "@/features/ai/runtimeConfig";

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

export function managedAiRuntimeUrls(provider: AiRuntimeManagedProvider) {
  const base = new URL(provider.baseUrl);
  return {
    models: new URL("models", base).href,
    chatCompletions: new URL("chat/completions", base).href
  };
}

export function isManagedAiRuntimeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  provider: AiRuntimeManagedProvider
) {
  const target = requestUrl(input);
  if (target.username || target.password || target.search || target.hash) return false;
  const urls = managedAiRuntimeUrls(provider);
  const method = requestMethod(input, init);
  return (method === "GET" && target.href === urls.models) ||
    (method === "POST" && target.href === urls.chatCompletions);
}

export function installManagedAiRuntimeFetch(provider: AiRuntimeManagedProvider) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const boundFetch: typeof fetch = (input, init) => {
    if (!isManagedAiRuntimeRequest(input, init, provider)) {
      return Promise.reject(new Error("ai_runtime_request_outside_managed_provider"));
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
