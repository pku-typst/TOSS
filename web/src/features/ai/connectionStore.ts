import {
  AI_RUNTIME_MODEL_TOKEN_LIMITS,
  AI_RUNTIME_PROVIDER_PROTOCOLS,
  isAiRuntimeModelTokenBudget,
  isAiRuntimeProviderProtocol,
  type AiRuntimeConnection,
  type AiRuntimeProviderProtocol
} from "@/features/ai/protocol";
import {
  formatAiProviderRequestOverrides,
  isAiProviderRequestOverrides,
  parseAiProviderRequestOverrides,
  type AiProviderRequestOverrides
} from "@/features/ai/providerRequest";
import { normalizeAiRuntimeEndpoint } from "@/features/ai/runtimePolicy";

export const AI_CONNECTION_STORE_SCHEMA = 1 as const;
export const MAX_AI_CONNECTIONS = 20;

const STORAGE_PREFIX = "toss.ai.connections.v1";
const MAX_STORED_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 80;
const MAX_MODEL_LENGTH = 256;

export type StoredAiConnection = {
  id: string;
  name: string;
  protocol: AiRuntimeProviderProtocol;
  endpoint: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  requestOverrides: AiProviderRequestOverrides;
};

export type StoredAiConnections = {
  schema: typeof AI_CONNECTION_STORE_SCHEMA;
  activeConnectionId?: string;
  connections: StoredAiConnection[];
};

export type AiConnectionDraft = {
  name: string;
  protocol: AiRuntimeProviderProtocol;
  endpoint: string;
  model: string;
  contextWindow: string;
  maxOutputTokens: string;
  reasoning: boolean;
  requestOverrides: string;
};

export function emptyStoredAiConnections(): StoredAiConnections {
  return { schema: AI_CONNECTION_STORE_SCHEMA, connections: [] };
}

export function activeStoredAiConnection(stored: StoredAiConnections) {
  return stored.connections.find(
    (connection) => connection.id === stored.activeConnectionId
  ) ?? null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function parseTokenCount(value: unknown) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeConnection(
  value: unknown,
  applicationOrigin: string
): StoredAiConnection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "name",
      "protocol",
      "endpoint",
      "model",
      "contextWindow",
      "maxOutputTokens",
      "reasoning",
      "requestOverrides"
    ]) ||
    !isBoundedText(value.id, MAX_ID_LENGTH) ||
    !isBoundedText(value.name, MAX_NAME_LENGTH) ||
    !isAiRuntimeProviderProtocol(value.protocol) ||
    !isBoundedText(value.endpoint, 2_048) ||
    !isBoundedText(value.model, MAX_MODEL_LENGTH) ||
    typeof value.reasoning !== "boolean" ||
    !isAiProviderRequestOverrides(value.requestOverrides)
  ) {
    return null;
  }
  const contextWindow = parseTokenCount(value.contextWindow);
  const maxOutputTokens = parseTokenCount(value.maxOutputTokens);
  if (!isAiRuntimeModelTokenBudget(contextWindow, maxOutputTokens)) return null;
  try {
    return {
      id: value.id.trim(),
      name: value.name.trim(),
      protocol: value.protocol,
      endpoint: normalizeAiRuntimeEndpoint(value.endpoint, applicationOrigin).baseUrl,
      model: value.model.trim(),
      contextWindow: Number(contextWindow),
      maxOutputTokens: Number(maxOutputTokens),
      reasoning: value.reasoning,
      requestOverrides: value.requestOverrides
    };
  } catch {
    return null;
  }
}

export function parseStoredAiConnections(
  raw: string,
  applicationOrigin: string
): StoredAiConnections | null {
  if (raw.length === 0 || raw.length > MAX_STORED_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const expectedKeys = value.activeConnectionId === undefined
    ? ["schema", "connections"]
    : ["schema", "activeConnectionId", "connections"];
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.schema !== AI_CONNECTION_STORE_SCHEMA ||
    !Array.isArray(value.connections) ||
    value.connections.length > MAX_AI_CONNECTIONS ||
    (value.activeConnectionId !== undefined &&
      !isBoundedText(value.activeConnectionId, MAX_ID_LENGTH))
  ) {
    return null;
  }
  const connections: StoredAiConnection[] = [];
  const ids = new Set<string>();
  for (const entry of value.connections) {
    const connection = normalizeConnection(entry, applicationOrigin);
    if (!connection || ids.has(connection.id)) return null;
    ids.add(connection.id);
    connections.push(connection);
  }
  const activeConnectionId = typeof value.activeConnectionId === "string"
    ? value.activeConnectionId.trim()
    : undefined;
  if (activeConnectionId && !ids.has(activeConnectionId)) return null;
  return {
    schema: AI_CONNECTION_STORE_SCHEMA,
    ...(activeConnectionId ? { activeConnectionId } : {}),
    connections
  };
}

export function aiConnectionStorageKey(accountId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;
}

export function loadStoredAiConnections(
  accountId: string | null,
  applicationOrigin: string,
  storage: Pick<Storage, "getItem" | "removeItem"> = window.localStorage
): StoredAiConnections {
  if (!accountId) return emptyStoredAiConnections();
  const key = aiConnectionStorageKey(accountId);
  const raw = storage.getItem(key);
  if (!raw) return emptyStoredAiConnections();
  const parsed = parseStoredAiConnections(raw, applicationOrigin);
  if (parsed) return parsed;
  storage.removeItem(key);
  return emptyStoredAiConnections();
}

export function saveStoredAiConnections(
  accountId: string | null,
  value: StoredAiConnections,
  storage: Pick<Storage, "setItem"> = window.localStorage
) {
  if (!accountId) return;
  storage.setItem(aiConnectionStorageKey(accountId), JSON.stringify(value));
}

export function createStoredAiConnection(
  id: string,
  draft: AiConnectionDraft,
  applicationOrigin: string
): StoredAiConnection {
  const requestOverrides = parseAiProviderRequestOverrides(draft.requestOverrides);
  if (!requestOverrides) throw new Error("ai_connection_invalid_request_overrides");
  const connection = normalizeConnection({
    id,
    name: draft.name,
    protocol: draft.protocol,
    endpoint: draft.endpoint,
    model: draft.model,
    contextWindow: draft.contextWindow,
    maxOutputTokens: draft.maxOutputTokens,
    reasoning: draft.reasoning,
    requestOverrides
  }, applicationOrigin);
  if (!connection) throw new Error("ai_connection_invalid");
  return connection;
}

export function toRuntimeConnection(connection: StoredAiConnection): AiRuntimeConnection {
  return {
    kind: "endpoint",
    connectionId: connection.id,
    protocol: connection.protocol,
    baseUrl: connection.endpoint,
    model: connection.model,
    contextWindow: connection.contextWindow,
    maxOutputTokens: connection.maxOutputTokens,
    reasoning: connection.reasoning,
    requestOverrides: connection.requestOverrides
  };
}

export function defaultAiConnectionDraft(): AiConnectionDraft {
  return {
    name: "",
    protocol: AI_RUNTIME_PROVIDER_PROTOCOLS[0],
    endpoint: "",
    model: "",
    contextWindow: String(AI_RUNTIME_MODEL_TOKEN_LIMITS.defaultContextWindow),
    maxOutputTokens: String(AI_RUNTIME_MODEL_TOKEN_LIMITS.defaultMaxOutputTokens),
    reasoning: false,
    requestOverrides: formatAiProviderRequestOverrides({})
  };
}
