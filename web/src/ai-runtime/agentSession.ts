import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Usage
} from "@earendil-works/pi-ai";
import { transformAgentContext } from "@/ai-runtime/contextManager";
import { applyAiProviderRequestOverrides } from "@/features/ai/providerRequest";
import type {
  AiRuntimeConnection,
  AiRuntimeConversationHistoryMessage,
  AiRuntimeTokenUsage
} from "@/features/ai/protocol";
import { AI_RUNTIME_MODEL_TOKEN_LIMITS } from "@/features/ai/protocol";
import {
  DEFAULT_AI_RUNTIME_PREFERENCES,
  type AiRuntimePreferences
} from "@/features/ai/runtimePreferences";


type EndpointConnection = Extract<AiRuntimeConnection, { kind: "endpoint" }>;

export type AiAgentFailureCode =
  | "ai_agent_context_budget_exceeded"
  | "ai_agent_provider_call_budget_exceeded"
  | "ai_agent_turn_timeout"
  | "provider_request_failed";

export type AiAgentTurnResult =
  | { outcome: "completed" | "cancelled" }
  | { outcome: "failed"; code: AiAgentFailureCode };

export type AiAgentContentEvent =
  | { type: "start"; blockId: string; kind: "text" | "reasoning" }
  | { type: "delta"; blockId: string; delta: string }
  | { type: "end"; blockId: string };

export type AiAgentSessionOptions = {
  connection: EndpointConnection;
  credential: string;
  conversationId: string;
  history: readonly AiRuntimeConversationHistoryMessage[];
  stream: StreamFn;
  systemPrompt: string;
  tools?: AgentTool[];
  preferences?: AiRuntimePreferences;
  onContent: (turnId: string, event: AiAgentContentEvent) => void;
  onUsage?: (turnId: string, usage: AiRuntimeTokenUsage) => void;
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
} as const;

function agentError(model: Model<Api>, errorMessage: AiAgentFailureCode) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: Date.now()
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  });
  return stream;
}

function connectionModel(connection: EndpointConnection): Model<Api> {
  const shared = {
    id: connection.model,
    name: connection.model,
    api: connection.protocol,
    provider: `toss-user-${connection.protocol}`,
    baseUrl: connection.baseUrl,
    reasoning: connection.reasoning,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: connection.contextWindow,
    maxTokens: connection.maxOutputTokens
  };
  if (connection.protocol === "openai-completions") {
    return {
      ...shared,
      api: connection.protocol,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens"
      }
    };
  }
  if (connection.protocol === "anthropic-messages") {
    return {
      ...shared,
      api: connection.protocol,
      compat: {
        supportsEagerToolInputStreaming: false,
        supportsLongCacheRetention: false,
        supportsCacheControlOnTools: false
      }
    };
  }
  return { ...shared, api: connection.protocol };
}

function restoredAgentHistory(
  history: readonly AiRuntimeConversationHistoryMessage[],
  model: Model<Api>
): AgentMessage[] {
  return history.map((message): AgentMessage => message.role === "user"
    ? {
        role: "user",
        content: message.content,
        timestamp: message.timestamp
      }
    : {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: message.timestamp
      });
}

function providerSessionId(connectionId: string, conversationId: string) {
  return `${connectionId}:${conversationId}`;
}

export class AiAgentSession {
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  private readonly connectionId: string;
  private activeTurnId: string | null = null;
  private cancelledTurnId: string | null = null;
  private providerCallsThisTurn = 0;
  private assistantMessageIndex = -1;
  private readonly openContentBlocks = new Map<string, "text" | "reasoning">();
  private readonly onUsage: AiAgentSessionOptions["onUsage"];
  private preferences: AiRuntimePreferences;
  private contextOverflow = false;
  private compactedMessagesThisTurn = 0;
  private contextTokensThisTurn = 0;
  private reportedCallsThisTurn = 0;
  private inputTokensThisTurn = 0;
  private outputTokensThisTurn = 0;
  private reasoningTokensThisTurn = 0;
  private cacheReadTokensThisTurn = 0;
  private cacheWriteTokensThisTurn = 0;
  private totalTokensThisTurn = 0;

  constructor(options: AiAgentSessionOptions) {
    this.connectionId = options.connection.connectionId;
    this.onUsage = options.onUsage;
    this.preferences = options.preferences ?? DEFAULT_AI_RUNTIME_PREFERENCES;
    const model = connectionModel(options.connection);
    const apiKey = options.credential || "unused";
    const stream: StreamFn = (model, context, streamOptions) => {
      if (this.contextOverflow) {
        return agentError(model, "ai_agent_context_budget_exceeded");
      }
      this.providerCallsThisTurn += 1;
      if (this.providerCallsThisTurn > this.preferences.maxProviderCallsPerTurn) {
        return agentError(model, "ai_agent_provider_call_budget_exceeded");
      }
      const upstreamOnPayload = streamOptions?.onPayload;
      return options.stream(model, context, {
        ...streamOptions,
        apiKey,
        cacheRetention: "none",
        timeoutMs: this.preferences.providerRequestTimeoutMs,
        maxRetries: 0,
        maxRetryDelayMs: 0,
        onPayload: async (payload, payloadModel) => {
          const upstreamPayload = await upstreamOnPayload?.(payload, payloadModel);
          return applyAiProviderRequestOverrides(
            upstreamPayload === undefined ? payload : upstreamPayload,
            options.connection.requestOverrides
          );
        }
      });
    };
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model,
        thinkingLevel: "off",
        tools: options.tools ?? [],
        messages: restoredAgentHistory(options.history, model)
      },
      streamFn: stream,
      sessionId: providerSessionId(this.connectionId, options.conversationId),
      toolExecution: "parallel",
      transformContext: async (messages) => {
        const transformed = transformAgentContext({
          messages,
          systemPrompt: this.agent.state.systemPrompt,
          tools: this.agent.state.tools,
          contextWindow: options.connection.contextWindow,
          maxOutputTokens: options.connection.maxOutputTokens,
          safetyTokens: AI_RUNTIME_MODEL_TOKEN_LIMITS.contextSafetyTokens
        });
        this.contextOverflow = transformed.overflow;
        this.contextTokensThisTurn = transformed.contextTokens;
        this.compactedMessagesThisTurn = Math.max(
          this.compactedMessagesThisTurn,
          transformed.compactedMessages
        );
        this.emitUsage("estimated");
        return transformed.messages;
      }
    });
    this.unsubscribe = this.agent.subscribe((event) => {
      if (!this.activeTurnId) return;
      if (event.type === "message_start" && event.message.role === "assistant") {
        this.assistantMessageIndex += 1;
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        this.recordProviderUsage(event.message.usage);
        return;
      }
      if (event.type !== "message_update") return;
      const update = event.assistantMessageEvent;
      const kind = update.type.startsWith("text_")
        ? "text" as const
        : update.type.startsWith("thinking_")
          ? "reasoning" as const
          : null;
      if (!kind || !("contentIndex" in update)) return;
      if (this.assistantMessageIndex < 0) this.assistantMessageIndex = 0;
      const blockId = `content-${this.assistantMessageIndex}-${update.contentIndex}`;
      if (update.type.endsWith("_start")) {
        if (!this.openContentBlocks.has(blockId)) {
          this.openContentBlocks.set(blockId, kind);
          options.onContent(this.activeTurnId, { type: "start", blockId, kind });
        }
        return;
      }
      if (!this.openContentBlocks.has(blockId)) {
        this.openContentBlocks.set(blockId, kind);
        options.onContent(this.activeTurnId, { type: "start", blockId, kind });
      }
      if (update.type.endsWith("_delta") && "delta" in update) {
        options.onContent(this.activeTurnId, {
          type: "delta",
          blockId,
          delta: update.delta
        });
      } else if (update.type.endsWith("_end")) {
        this.openContentBlocks.delete(blockId);
        options.onContent(this.activeTurnId, { type: "end", blockId });
      }
    });
  }

  setSystemPrompt(systemPrompt: string) {
    this.agent.state.systemPrompt = systemPrompt;
  }

  setTools(tools: AgentTool[]) {
    this.agent.state.tools = tools;
  }

  setPreferences(preferences: AiRuntimePreferences) {
    if (this.busy) throw new Error("ai_agent_turn_in_progress");
    this.preferences = { ...preferences };
  }

  setConversation(
    conversationId: string,
    history: readonly AiRuntimeConversationHistoryMessage[]
  ) {
    if (this.busy) throw new Error("ai_agent_turn_in_progress");
    this.agent.reset();
    this.agent.state.messages = restoredAgentHistory(history, this.agent.state.model);
    this.agent.sessionId = providerSessionId(this.connectionId, conversationId);
  }

  get busy() {
    return this.activeTurnId !== null;
  }

  private usageSnapshot(contextSource: AiRuntimeTokenUsage["contextSource"]): AiRuntimeTokenUsage {
    return {
      contextWindow: this.agent.state.model.contextWindow,
      maxOutputTokens: this.agent.state.model.maxTokens,
      contextTokens: this.contextTokensThisTurn,
      contextSource,
      providerCalls: Math.min(
        this.providerCallsThisTurn,
        this.preferences.maxProviderCallsPerTurn
      ),
      reportedCalls: this.reportedCallsThisTurn,
      inputTokens: this.inputTokensThisTurn,
      outputTokens: this.outputTokensThisTurn,
      reasoningTokens: this.reasoningTokensThisTurn,
      cacheReadTokens: this.cacheReadTokensThisTurn,
      cacheWriteTokens: this.cacheWriteTokensThisTurn,
      totalTokens: this.totalTokensThisTurn,
      compactedMessages: this.compactedMessagesThisTurn
    };
  }

  private emitUsage(contextSource: AiRuntimeTokenUsage["contextSource"]) {
    if (!this.activeTurnId) return;
    this.onUsage?.(this.activeTurnId, this.usageSnapshot(contextSource));
  }

  private recordProviderUsage(usage: Usage) {
    const bounded = (value: number | undefined) => Number.isFinite(value) && Number(value) > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(value)))
      : 0;
    const input = bounded(usage.input);
    const output = bounded(usage.output);
    const cacheRead = bounded(usage.cacheRead);
    const cacheWrite = bounded(usage.cacheWrite);
    const reasoning = Math.min(output, bounded(usage.reasoning));
    const reportedTotal = bounded(usage.totalTokens);
    const total = reportedTotal || input + output + cacheRead + cacheWrite;
    if (total === 0) {
      this.emitUsage("estimated");
      return;
    }
    const add = (current: number, value: number) => Math.min(
      Number.MAX_SAFE_INTEGER,
      current + value
    );
    this.reportedCallsThisTurn += 1;
    this.inputTokensThisTurn = add(this.inputTokensThisTurn, input);
    this.outputTokensThisTurn = add(this.outputTokensThisTurn, output);
    this.reasoningTokensThisTurn = add(this.reasoningTokensThisTurn, reasoning);
    this.cacheReadTokensThisTurn = add(this.cacheReadTokensThisTurn, cacheRead);
    this.cacheWriteTokensThisTurn = add(this.cacheWriteTokensThisTurn, cacheWrite);
    this.totalTokensThisTurn = add(this.totalTokensThisTurn, total);
    this.contextTokensThisTurn = total;
    this.emitUsage("provider");
  }

  private failure(code: string | undefined): AiAgentFailureCode {
    if (
      code === "ai_agent_context_budget_exceeded" ||
      code === "ai_agent_provider_call_budget_exceeded" ||
      code === "ai_agent_turn_timeout"
    ) return code;
    return "provider_request_failed";
  }

  async prompt(turnId: string, prompt: string): Promise<AiAgentTurnResult> {
    if (this.activeTurnId) throw new Error("ai_agent_turn_in_progress");
    this.activeTurnId = turnId;
    this.cancelledTurnId = null;
    this.providerCallsThisTurn = 0;
    this.contextOverflow = false;
    this.compactedMessagesThisTurn = 0;
    this.contextTokensThisTurn = 0;
    this.reportedCallsThisTurn = 0;
    this.inputTokensThisTurn = 0;
    this.outputTokensThisTurn = 0;
    this.reasoningTokensThisTurn = 0;
    this.cacheReadTokensThisTurn = 0;
    this.cacheWriteTokensThisTurn = 0;
    this.totalTokensThisTurn = 0;
    this.assistantMessageIndex = -1;
    this.openContentBlocks.clear();
    let timedOut = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      this.agent.abort();
    }, this.preferences.maxTurnMs);
    try {
      await this.agent.prompt(prompt);
      if (timedOut) return { outcome: "failed", code: "ai_agent_turn_timeout" };
      if (this.cancelledTurnId === turnId) return { outcome: "cancelled" };
      return this.agent.state.errorMessage
        ? { outcome: "failed", code: this.failure(this.agent.state.errorMessage) }
        : { outcome: "completed" };
    } catch {
      return this.cancelledTurnId === turnId
        ? { outcome: "cancelled" }
        : { outcome: "failed", code: "provider_request_failed" };
    } finally {
      globalThis.clearTimeout(timer);
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      if (this.cancelledTurnId === turnId) this.cancelledTurnId = null;
      this.openContentBlocks.clear();
    }
  }

  cancel(turnId: string) {
    if (this.activeTurnId !== turnId) return false;
    this.cancelledTurnId = turnId;
    this.agent.abort();
    return true;
  }

  clear() {
    this.cancelledTurnId = this.activeTurnId;
    this.agent.abort();
    this.agent.reset();
  }

  dispose() {
    this.clear();
    this.unsubscribe();
  }
}
