import {
  isAiWorkspaceCapabilities,
  isAiWorkspaceContextSnapshot,
  isAiWorkspaceToolArguments,
  isAiWorkspaceToolExecution,
  isAiWorkspaceToolName,
  type AiWorkspaceCapabilities,
  type AiWorkspaceContextSnapshot,
  type AiWorkspaceToolExecution,
  type AiWorkspaceToolName,
  type AiWorkspaceToolRequest
} from "@/features/ai/toolContract";
import {
  isAiProviderRequestOverrides,
  type AiProviderRequestOverrides
} from "@/features/ai/providerRequest";

export const AI_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const AI_RUNTIME_BUILD_ID = __TOSS_AI_RUNTIME_BUILD_ID__;
export const AI_RUNTIME_ENTRY_PATH = "/_ai-runtime/bootstrap.html";
export const AI_ASSISTANT_PANEL_ID = "feature:ai_assistant" as const;

export type AiRuntimeLocale = "en" | "zh-CN";

const MAX_ID_LENGTH = 128;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_DELTA_LENGTH = 4_096;
const MAX_ERROR_LENGTH = 1_024;
export const AI_RUNTIME_CONVERSATION_HISTORY_LIMITS = {
  maxMessages: 24,
  maxContentLength: 32_768,
  maxTotalLength: 48_000
} as const;

export const AI_RUNTIME_PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages"
] as const;

export type AiRuntimeProviderProtocol = (typeof AI_RUNTIME_PROVIDER_PROTOCOLS)[number];

export const AI_RUNTIME_MODEL_TOKEN_LIMITS = {
  defaultContextWindow: 32_768,
  defaultMaxOutputTokens: 4_096,
  minContextWindow: 8_192,
  maxContextWindow: 4_194_304,
  minMaxOutputTokens: 256,
  maxMaxOutputTokens: 1_048_576,
  contextSafetyTokens: 4_096,
  minInputTokens: 1_024
} as const;

export function isAiRuntimeModelTokenBudget(
  contextWindow: unknown,
  maxOutputTokens: unknown
) {
  return (
    Number.isSafeInteger(contextWindow) &&
    Number.isSafeInteger(maxOutputTokens) &&
    Number(contextWindow) >= AI_RUNTIME_MODEL_TOKEN_LIMITS.minContextWindow &&
    Number(contextWindow) <= AI_RUNTIME_MODEL_TOKEN_LIMITS.maxContextWindow &&
    Number(maxOutputTokens) >= AI_RUNTIME_MODEL_TOKEN_LIMITS.minMaxOutputTokens &&
    Number(maxOutputTokens) <= AI_RUNTIME_MODEL_TOKEN_LIMITS.maxMaxOutputTokens &&
    Number(maxOutputTokens) + AI_RUNTIME_MODEL_TOKEN_LIMITS.contextSafetyTokens +
      AI_RUNTIME_MODEL_TOKEN_LIMITS.minInputTokens <= Number(contextWindow)
  );
}

export type AiRuntimeConnection =
  | { kind: "fake" }
  | {
      kind: "endpoint";
      connectionId: string;
      protocol: AiRuntimeProviderProtocol;
      baseUrl: string;
      model: string;
      contextWindow: number;
      maxOutputTokens: number;
      reasoning: boolean;
      requestOverrides: AiProviderRequestOverrides;
    };

export type AiRuntimeConversationHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type AiRuntimeConversationContext = {
  conversationId: string;
  history: AiRuntimeConversationHistoryMessage[];
};

export type AiRuntimeBootstrapInit = {
  type: "toss.ai.runtime.initialize";
  protocolVersion: typeof AI_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  sessionId: string;
  nonce: string;
  parentOrigin: string;
  locale: AiRuntimeLocale;
  connection: AiRuntimeConnection;
  conversation: AiRuntimeConversationContext;
  workspace: AiWorkspaceCapabilities | null;
};

export type AiRuntimeReady = {
  type: "toss.ai.runtime.ready";
  protocolVersion: typeof AI_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  sessionId: string;
  nonce: string;
};

export type AiRuntimeBootstrapAcknowledged = {
  type: "toss.ai.runtime.bootstrap_ack";
  protocolVersion: typeof AI_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  sessionId: string;
  nonce: string;
};

export type AiRuntimeContentStart = {
  type: "toss.ai.runtime.content_start";
  sessionId: string;
  turnId: string;
  blockId: string;
  kind: "text" | "reasoning";
};

export type AiRuntimeContentDelta = {
  type: "toss.ai.runtime.content_delta";
  sessionId: string;
  turnId: string;
  blockId: string;
  delta: string;
};

export type AiRuntimeContentEnd = {
  type: "toss.ai.runtime.content_end";
  sessionId: string;
  turnId: string;
  blockId: string;
};

export type AiRuntimeConnectionState = {
  type: "toss.ai.runtime.connection_state";
  sessionId: string;
  state: "credential_required" | "ready";
};

export type AiRuntimeTurnComplete = {
  type: "toss.ai.runtime.turn_complete";
  sessionId: string;
  turnId: string;
  outcome: "completed" | "cancelled";
};

export type AiRuntimeTokenUsage = {
  contextWindow: number;
  maxOutputTokens: number;
  contextTokens: number;
  contextSource: "estimated" | "provider";
  providerCalls: number;
  reportedCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  compactedMessages: number;
};

export type AiRuntimeUsageUpdate = AiRuntimeTokenUsage & {
  type: "toss.ai.runtime.usage";
  sessionId: string;
  turnId: string;
};

export type AiRuntimeError = {
  type: "toss.ai.runtime.error";
  sessionId: string;
  turnId?: string;
  code: string;
  message: string;
};

type AiRuntimeToolCallFor<TRequest extends AiWorkspaceToolRequest> = {
  type: "toss.ai.runtime.tool_call";
  sessionId: string;
  turnId: string;
  callId: string;
  tool: TRequest["tool"];
  arguments: TRequest["arguments"];
};

export type AiRuntimeToolCall = AiWorkspaceToolRequest extends infer TRequest
  ? TRequest extends AiWorkspaceToolRequest
    ? AiRuntimeToolCallFor<TRequest>
    : never
  : never;

export type AiRuntimeToolCancel = {
  type: "toss.ai.runtime.tool_cancel";
  sessionId: string;
  turnId: string;
  callId: string;
};

export type AiRuntimeToHostMessage =
  | AiRuntimeBootstrapAcknowledged
  | AiRuntimeReady
  | AiRuntimeConnectionState
  | AiRuntimeContentStart
  | AiRuntimeContentDelta
  | AiRuntimeContentEnd
  | AiRuntimeUsageUpdate
  | AiRuntimeTurnComplete
  | AiRuntimeToolCall
  | AiRuntimeToolCancel
  | AiRuntimeError;

export type AiRuntimeStartTurn = {
  type: "toss.ai.host.start_turn";
  sessionId: string;
  conversationId: string;
  turnId: string;
  prompt: string;
  workspace: AiWorkspaceContextSnapshot | null;
};

export type AiRuntimeSetConversation = {
  type: "toss.ai.host.set_conversation";
  sessionId: string;
  conversation: AiRuntimeConversationContext;
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

export type AiHostToolResult = {
  type: "toss.ai.host.tool_result";
  sessionId: string;
  turnId: string;
  callId: string;
  tool: AiWorkspaceToolName;
  response: AiWorkspaceToolExecution;
};

export type AiHostToRuntimeMessage =
  | AiRuntimeStartTurn
  | AiRuntimeCancelTurn
  | AiRuntimeSetLocale
  | AiRuntimeSetConversation
  | AiHostToolResult
  | AiRuntimeClearSession;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isAiRuntimeLocale(value: unknown): value is AiRuntimeLocale {
  return value === "en" || value === "zh-CN";
}

export function isAiRuntimeProviderProtocol(
  value: unknown
): value is AiRuntimeProviderProtocol {
  return AI_RUNTIME_PROVIDER_PROTOCOLS.some((protocol) => protocol === value);
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
    hasExactKeys(value, [
      "kind",
      "connectionId",
      "protocol",
      "baseUrl",
      "model",
      "contextWindow",
      "maxOutputTokens",
      "reasoning",
      "requestOverrides"
    ]) &&
    isBoundedString(value.connectionId, MAX_ID_LENGTH) &&
    isAiRuntimeProviderProtocol(value.protocol) &&
    isBoundedString(value.baseUrl, 2_048) &&
    isBoundedString(value.model, 256) &&
    isAiRuntimeModelTokenBudget(value.contextWindow, value.maxOutputTokens) &&
    typeof value.reasoning === "boolean" &&
    isAiProviderRequestOverrides(value.requestOverrides)
  );
}

export function isAiRuntimeConversationContext(
  value: unknown
): value is AiRuntimeConversationContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["conversationId", "history"]) ||
    !isBoundedString(value.conversationId, MAX_ID_LENGTH) ||
    !Array.isArray(value.history) ||
    value.history.length > AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxMessages ||
    value.history.length % 2 !== 0
  ) {
    return false;
  }
  let totalLength = 0;
  for (const message of value.history) {
    if (
      !isRecord(message) ||
      !hasExactKeys(message, ["role", "content", "timestamp"]) ||
      (message.role !== "user" && message.role !== "assistant") ||
      !isBoundedString(message.content, AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxContentLength) ||
      typeof message.timestamp !== "number" ||
      !Number.isFinite(message.timestamp) ||
      message.timestamp < 0
    ) {
      return false;
    }
    totalLength += message.content.length;
    if (totalLength > AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxTotalLength) return false;
  }
  return value.history.every((message, index) => (
    (index % 2 === 0 ? "user" : "assistant") === message.role
  ));
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
      "connection",
      "conversation",
      "workspace"
    ]) &&
    value.type === "toss.ai.runtime.initialize" &&
    value.protocolVersion === AI_RUNTIME_PROTOCOL_VERSION &&
    value.buildId === AI_RUNTIME_BUILD_ID &&
    isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    isBoundedString(value.nonce, MAX_ID_LENGTH) &&
    isBoundedString(value.parentOrigin, 2_048) &&
    isAiRuntimeLocale(value.locale) &&
    isRuntimeConnection(value.connection) &&
    isAiRuntimeConversationContext(value.conversation) &&
    (value.workspace === null || isAiWorkspaceCapabilities(value.workspace))
  );
}

export function isAiHostToRuntimeMessage(value: unknown): value is AiHostToRuntimeMessage {
  if (!isRecord(value) || !isBoundedString(value.type, 64)) return false;
  if (value.type === "toss.ai.host.start_turn") {
    return (
      hasExactKeys(value, ["type", "sessionId", "conversationId", "turnId", "prompt", "workspace"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.conversationId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.prompt, MAX_PROMPT_LENGTH) &&
      (value.workspace === null || isAiWorkspaceContextSnapshot(value.workspace))
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
  if (value.type === "toss.ai.host.set_conversation") {
    return (
      hasExactKeys(value, ["type", "sessionId", "conversation"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isAiRuntimeConversationContext(value.conversation)
    );
  }
  if (value.type === "toss.ai.host.tool_result") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "callId", "tool", "response"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.callId, MAX_ID_LENGTH) &&
      isAiWorkspaceToolName(value.tool) &&
      isAiWorkspaceToolExecution(value.tool, value.response)
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
  if (
    value.type === "toss.ai.runtime.bootstrap_ack" ||
    value.type === "toss.ai.runtime.ready"
  ) {
    return (
      hasExactKeys(value, ["type", "protocolVersion", "buildId", "sessionId", "nonce"]) &&
      value.protocolVersion === AI_RUNTIME_PROTOCOL_VERSION &&
      value.buildId === AI_RUNTIME_BUILD_ID &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.nonce, MAX_ID_LENGTH)
    );
  }
  if (value.type === "toss.ai.runtime.content_start") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "blockId", "kind"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.blockId, MAX_ID_LENGTH) &&
      (value.kind === "text" || value.kind === "reasoning")
    );
  }
  if (value.type === "toss.ai.runtime.content_delta") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "blockId", "delta"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.blockId, MAX_ID_LENGTH) &&
      isBoundedString(value.delta, MAX_DELTA_LENGTH)
    );
  }
  if (value.type === "toss.ai.runtime.content_end") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "blockId"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.blockId, MAX_ID_LENGTH)
    );
  }
  if (value.type === "toss.ai.runtime.connection_state") {
    return (
      hasExactKeys(value, ["type", "sessionId", "state"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      (value.state === "credential_required" || value.state === "ready")
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
  if (value.type === "toss.ai.runtime.usage") {
    return (
      hasExactKeys(value, [
        "type",
        "sessionId",
        "turnId",
        "contextWindow",
        "maxOutputTokens",
        "contextTokens",
        "contextSource",
        "providerCalls",
        "reportedCalls",
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "totalTokens",
        "compactedMessages"
      ]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isAiRuntimeModelTokenBudget(value.contextWindow, value.maxOutputTokens) &&
      isSafeNonNegativeInteger(value.contextTokens) &&
      (value.contextSource === "estimated" || value.contextSource === "provider") &&
      isSafeNonNegativeInteger(value.providerCalls) &&
      isSafeNonNegativeInteger(value.reportedCalls) &&
      value.reportedCalls <= value.providerCalls &&
      isSafeNonNegativeInteger(value.inputTokens) &&
      isSafeNonNegativeInteger(value.outputTokens) &&
      isSafeNonNegativeInteger(value.reasoningTokens) &&
      value.reasoningTokens <= value.outputTokens &&
      isSafeNonNegativeInteger(value.cacheReadTokens) &&
      isSafeNonNegativeInteger(value.cacheWriteTokens) &&
      isSafeNonNegativeInteger(value.totalTokens) &&
      isSafeNonNegativeInteger(value.compactedMessages)
    );
  }
  if (value.type === "toss.ai.runtime.tool_call") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "callId", "tool", "arguments"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.callId, MAX_ID_LENGTH) &&
      isAiWorkspaceToolName(value.tool) &&
      isAiWorkspaceToolArguments(value.tool, value.arguments)
    );
  }
  if (value.type === "toss.ai.runtime.tool_cancel") {
    return (
      hasExactKeys(value, ["type", "sessionId", "turnId", "callId"]) &&
      isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
      isBoundedString(value.turnId, MAX_ID_LENGTH) &&
      isBoundedString(value.callId, MAX_ID_LENGTH)
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
