export type AiProviderJsonValue =
  | null
  | boolean
  | number
  | string
  | AiProviderJsonValue[]
  | { [key: string]: AiProviderJsonValue };

export type AiProviderRequestOverrides = Record<string, AiProviderJsonValue>;

export const AI_PROVIDER_REQUEST_OVERRIDE_LIMITS = {
  maxSerializedLength: 16_384,
  maxDepth: 8,
  maxEntries: 128,
  maxArrayLength: 128,
  maxKeyLength: 128,
  maxStringLength: 8_192
} as const;

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "accesstoken",
  "bearertoken",
  "token",
  "credential",
  "credentials",
  "password",
  "secret",
  "clientsecret"
]);
const PROTECTED_ROOT_KEYS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "headers"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSecretKey(key: string) {
  return key.toLowerCase().replaceAll(/[-_]/g, "");
}

function validateJsonValue(
  value: unknown,
  depth: number,
  state: { entries: number; seen: WeakSet<object> }
): value is AiProviderJsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return value.length <= AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxStringLength;
  }
  if (typeof value !== "object" || depth > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxDepth) {
    return false;
  }
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxArrayLength) return false;
    for (const item of value) {
      state.entries += 1;
      if (
        state.entries > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxEntries ||
        !validateJsonValue(item, depth + 1, state)
      ) return false;
    }
    return true;
  }
  for (const [key, item] of Object.entries(value)) {
    state.entries += 1;
    if (
      state.entries > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxEntries ||
      key.length === 0 ||
      key.length > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxKeyLength ||
      FORBIDDEN_OBJECT_KEYS.has(key) ||
      FORBIDDEN_SECRET_KEYS.has(normalizedSecretKey(key)) ||
      !validateJsonValue(item, depth + 1, state)
    ) return false;
  }
  return true;
}

export function isAiProviderRequestOverrides(
  value: unknown
): value is AiProviderRequestOverrides {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (PROTECTED_ROOT_KEYS.has(key)) return false;
  }
  if (!validateJsonValue(value, 0, { entries: 0, seen: new WeakSet() })) return false;
  try {
    return JSON.stringify(value).length <=
      AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxSerializedLength;
  } catch {
    return false;
  }
}

export function parseAiProviderRequestOverrides(raw: string): AiProviderRequestOverrides | null {
  if (
    raw.length === 0 ||
    raw.length > AI_PROVIDER_REQUEST_OVERRIDE_LIMITS.maxSerializedLength
  ) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isAiProviderRequestOverrides(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatAiProviderRequestOverrides(value: AiProviderRequestOverrides) {
  return JSON.stringify(value, null, 2);
}

export function hasAiProviderRequestOverrides(value: AiProviderRequestOverrides) {
  return Object.keys(value).length > 0;
}

function cloneJsonValue(value: AiProviderJsonValue): AiProviderJsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!isRecord(value)) return value;
  const cloned: Record<string, AiProviderJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = cloneJsonValue(item as AiProviderJsonValue);
  }
  return cloned;
}

function mergeObject(
  base: Record<string, unknown>,
  overrides: AiProviderRequestOverrides
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, override] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(override)
      ? mergeObject(existing, override as AiProviderRequestOverrides)
      : cloneJsonValue(override);
  }
  return merged;
}

export function applyAiProviderRequestOverrides(
  payload: unknown,
  overrides: AiProviderRequestOverrides
): unknown {
  if (!isRecord(payload) || !hasAiProviderRequestOverrides(overrides)) return payload;
  return mergeObject(payload, overrides);
}
