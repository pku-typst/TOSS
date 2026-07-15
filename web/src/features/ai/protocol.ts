export const AI_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const AI_RUNTIME_BUILD_ID = __TOSS_AI_RUNTIME_BUILD_ID__;
export const AI_RUNTIME_ENTRY_PATH = "/_ai-runtime/bootstrap.html";
export const AI_ASSISTANT_PANEL_ID = "feature:ai_assistant" as const;

export type AiRuntimeLocale = "en" | "zh-CN";

const MAX_ID_LENGTH = 128;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_DELTA_LENGTH = 4_096;
const MAX_ERROR_LENGTH = 1_024;

export type AiRuntimeConnection =
  | { kind: "fake" }
  | { kind: "endpoint"; baseUrl: string };

export type AiRuntimeBootstrapInit = {
  type: "toss.ai.runtime.initialize";
  protocolVersion: typeof AI_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  sessionId: string;
  nonce: string;
  parentOrigin: string;
  locale: AiRuntimeLocale;
  connection: AiRuntimeConnection;
};

export type AiRuntimeReady = {
  type: "toss.ai.runtime.ready";
  protocolVersion: typeof AI_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  sessionId: string;
  nonce: string;
};

export type AiRuntimeAssistantDelta = {
  type: "toss.ai.runtime.assistant_delta";
  sessionId: string;
  turnId: string;
  text: string;
};

export type AiRuntimeTurnComplete = {
  type: "toss.ai.runtime.turn_complete";
  sessionId: string;
  turnId: string;
  outcome: "completed" | "cancelled";
};

export type AiRuntimeError = {
  type: "toss.ai.runtime.error";
  sessionId: string;
  turnId?: string;
  code: string;
  message: string;
};

export type AiRuntimeToHostMessage =
  | AiRuntimeReady
  | AiRuntimeAssistantDelta
  | AiRuntimeTurnComplete
  | AiRuntimeError;

export type AiRuntimeStartTurn = {
  type: "toss.ai.host.start_turn";
  sessionId: string;
  turnId: string;
  prompt: string;
};

export type AiRuntimeCancelTurn = {
  type: "toss.ai.host.cancel_turn";
  sessionId: string;
  turnId: string;
};

export type AiRuntimeClearSession = {
  type: "toss.ai.host.clear_session";
  sessionId: string;
};

export type AiRuntimeSetLocale = {
  type: "toss.ai.host.set_locale";
  sessionId: string;
  locale: AiRuntimeLocale;
};

export type AiHostToRuntimeMessage =
  | AiRuntimeStartTurn
  | AiRuntimeCancelTurn
  | AiRuntimeSetLocale
  | AiRuntimeClearSession;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isAiRuntimeLocale(value: unknown): value is AiRuntimeLocale {
  return value === "en" || value === "zh-CN";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRuntimeConnection(value: unknown): value is AiRuntimeConnection {
  if (!isRecord(value) || !isBoundedString(value.kind, 32)) return false;
  if (value.kind === "fake") return hasExactKeys(value, ["kind"]);
  return (
    value.kind === "endpoint" &&
    hasExactKeys(value, ["kind", "baseUrl"]) &&
    isBoundedString(value.baseUrl, 2_048)
  );
}

export function isAiRuntimeBootstrapInit(value: unknown): value is AiRuntimeBootstrapInit {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "buildId",
      "sessionId",
      "nonce",
      "parentOrigin",
      "locale",
      "connection"
    ]) &&
    value.type === "toss.ai.runtime.initialize" &&
    value.protocolVersion === AI_RUNTIME_PROTOCOL_VERSION &&
    value.buildId === AI_RUNTIME_BUILD_ID &&
    isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    isBoundedString(value.nonce, MAX_ID_LENGTH) &&
    isBoundedString(value.parentOrigin, 2_048) &&
    isAiRuntimeLocale(value.locale) &&
    isRuntimeConnection(value.connection)
  );
}

export function isAiHostToRuntimeMessage(value: unknown): value is AiHostToRuntimeMessage {
  if (!isRecord(value) || !isBoundedString(value.type, 64)) return false;
  if (value.type === "toss.ai.host.start_turn") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "prompt"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.prompt, MAX_PROMPT_LENGTH)
    );
  }
  if (value.type === "toss.ai.host.cancel_turn") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH)
    );
  }
  if (value.type === "toss.ai.host.set_locale") {
    return (
      hasExactKeys(value, ["type", "sessionId", "locale"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isAiRuntimeLocale(value.locale)
    );
  }
  return (
    value.type === "toss.ai.host.clear_session" &&
    hasExactKeys(value, ["type", "sessionId"]) &&
    isBoundedString(value.sessionId, MAX_ID_LENGTH)
  );
}

export function isAiRuntimeToHostMessage(value: unknown): value is AiRuntimeToHostMessage {
  if (!isRecord(value) || !isBoundedString(value.type, 64)) return false;
  if (value.type === "toss.ai.runtime.ready") {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "buildId", "sessionId", "nonce"]) &&
      value.protocolVersion === AI_RUNTIME_PROTOCOL_VERSION &&
      value.buildId === AI_RUNTIME_BUILD_ID &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.nonce, MAX_ID_LENGTH)
    );
  }
  if (value.type === "toss.ai.runtime.assistant_delta") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "text"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.text, MAX_DELTA_LENGTH)
    );
  }
  if (value.type === "toss.ai.runtime.turn_complete") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "outcome"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      (value.outcome === "completed" || value.outcome === "cancelled")
    );
  }
  if (value.type !== "toss.ai.runtime.error") return false;
  const allowedKeys = value.turnId === undefined
    ? ["type", "sessionId", "code", "message"]
    : ["type", "sessionId", "turnId", "code", "message"];
  return (
    hasExactKeys(value, allowedKeys) &&
    isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    (value.turnId === undefined || isBoundedString(value.turnId, MAX_ID_LENGTH)) &&
    isBoundedString(value.code, 64) &&
    isBoundedString(value.message, MAX_ERROR_LENGTH)
  );
}
