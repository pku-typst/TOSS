import {
  AI_RUNTIME_CONVERSATION_HISTORY_LIMITS,
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiRuntimeToHostMessage,
  type AiHostToRuntimeMessage,
  type AiRuntimeBootstrapInit,
  type AiRuntimeConnection,
  type AiRuntimeConversationContext,
  type AiRuntimeConversationHistoryMessage,
  type AiRuntimeLocale,
  type AiRuntimeManagedCatalogModel,
  type AiRuntimeManagedModelSelection,
  type AiRuntimeManagedSelectionIdentity,
  type AiRuntimeTokenUsage,
  type AiRuntimeToolCall,
  type AiRuntimeToHostMessage
} from "@/features/ai/protocol";
import {
  AI_WORKSPACE_TOOL_LIMITS,
  isAiWorkspaceContextSnapshot,
  isAiWorkspaceToolExecution,
  type AiWorkspaceContextSnapshot,
  type AiWorkspaceEditReviewOutcome,
  type AiWorkspaceToolErrorCode,
  type AiWorkspaceToolExecution,
  type AiWorkspaceToolName,
  type AiWorkspaceToolPort,
  type AiWorkspaceToolRequest
} from "@/features/ai/toolContract";
import {
  DEFAULT_AI_RUNTIME_PREFERENCES,
  type AiRuntimePreferences
} from "@/features/ai/runtimePreferences";
import { readRuntimeDesignTheme } from "@/design/runtimeTheme";

export type AiRuntimeStatus =
  | "idle"
  | "handshaking"
  | "configuring"
  | "ready"
  | "running"
  | "error";

export type AiTurnRecovery = "retry" | "continue";

export type AiTranscriptContentPart = {
  id: string;
  type: "text" | "reasoning";
  text: string;
  state: "streaming" | "complete";
  startedAt: number;
  completedAt: number | null;
};

export type AiTranscriptToolOutcome =
  | "success"
  | "review_pending"
  | "accepted"
  | "rejected"
  | "stale"
  | "cancelled"
  | "compile_failed";

export type AiTranscriptToolPart = {
  id: string;
  type: "tool";
  tool: AiWorkspaceToolName;
  path: string | null;
  query: string | null;
  startLine: number | null;
  endLine: number | null;
  reviewId: string | null;
  state: "running" | "complete" | "error" | "cancelled";
  outcome: AiTranscriptToolOutcome | null;
  errorCode: AiWorkspaceToolErrorCode | null;
  startedAt: number;
  completedAt: number | null;
};

export type AiTranscriptPart = AiTranscriptContentPart | AiTranscriptToolPart;

export type AiTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  parts: readonly AiTranscriptPart[];
  state: "complete" | "streaming" | "cancelled" | "error" | "interrupted";
  startedAt: number;
  completedAt: number | null;
};

export type AiRuntimeSnapshot = {
  status: AiRuntimeStatus;
  conversationId: string;
  messages: readonly AiTranscriptMessage[];
  activeTurnId: string | null;
  error: string | null;
  errorMessage: string | null;
  usage: AiRuntimeTokenUsage | null;
  managedCatalog: {
    availableRecommendedProfileIds: readonly string[];
    models: readonly AiRuntimeManagedCatalogModel[];
    selectedModel: AiRuntimeManagedSelectionIdentity | null;
    errorCode: string | null;
  } | null;
  queuedPrompt: string | null;
  recovery: AiTurnRecovery | null;
  persistenceRevision: number;
};

const HANDSHAKE_TIMEOUT_MS = 5_000;
const RUNTIME_PREPARATION_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_MESSAGE_LENGTH = 131_072;

function secureId(prefix: string) {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function replaceMessage(
  messages: readonly AiTranscriptMessage[],
  id: string,
  update: (message: AiTranscriptMessage) => AiTranscriptMessage
) {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

function replacePart(
  message: AiTranscriptMessage,
  id: string,
  update: (part: AiTranscriptPart) => AiTranscriptPart
): AiTranscriptMessage {
  return {
    ...message,
    parts: message.parts.map((part) => part.id === id ? update(part) : part)
  };
}

function contentLength(message: AiTranscriptMessage) {
  return message.parts.reduce(
    (total, part) => total + (part.type === "text" || part.type === "reasoning" ? part.text.length : 0),
    0
  );
}

function hasPendingEditReview(messages: readonly AiTranscriptMessage[]) {
  return messages.some((message) => message.parts.some((part) => (
    part.type === "tool" && part.outcome === "review_pending"
  )));
}

function reconcilePendingEditReviews(
  messages: readonly AiTranscriptMessage[],
  workspace: AiWorkspaceContextSnapshot
) {
  if (workspace.pending_edit_review || !hasPendingEditReview(messages)) {
    return { messages, changed: false };
  }
  let changed = false;
  const reconciled = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool" || part.outcome !== "review_pending") return part;
      changed = true;
      return {
        ...part,
        outcome: workspace.last_edit_review?.review_id === part.reviewId
          ? workspace.last_edit_review.decision
          : "cancelled" as const
      };
    })
  }));
  return { messages: reconciled, changed };
}

const MAX_BUFFERED_REVIEW_OUTCOMES = 32;

function settleMessage(
  message: AiTranscriptMessage,
  state: "complete" | "cancelled" | "error"
): AiTranscriptMessage {
  const completedAt = Date.now();
  return {
    ...message,
    state,
    completedAt,
    parts: message.parts.map((part) => {
      if (part.type !== "tool") {
        return part.state === "complete"
          ? part
          : { ...part, state: "complete" as const, completedAt };
      }
      if (part.state !== "running") return part;
      return {
        ...part,
        state: state === "cancelled" ? "cancelled" as const : "error" as const,
        completedAt
      };
    })
  };
}

function toolPresentation(message: AiRuntimeToolCall) {
  const args = message.arguments as Record<string, unknown>;
  const packageSpec = typeof args.package_spec === "string" ? args.package_spec : null;
  const explicitPath = typeof args.path === "string" ? args.path : null;
  const prefix = typeof args.path_prefix === "string" && args.path_prefix
    ? args.path_prefix
    : null;
  return {
    path: packageSpec
      ? explicitPath ? `${packageSpec} · ${explicitPath}` : packageSpec
      : explicitPath ?? prefix,
    query: typeof args.query === "string" ? args.query.slice(0, 256) : null,
    startLine: typeof args.start_line === "number" ? args.start_line : null,
    endLine: typeof args.end_line === "number" ? args.end_line : null
  };
}

export class AiRuntimeClient {
  private conversation: AiRuntimeConversationContext;
  private snapshot: AiRuntimeSnapshot = {
    status: "idle",
    conversationId: "",
    messages: [],
    activeTurnId: null,
    error: null,
    errorMessage: null,
    usage: null,
    managedCatalog: null,
    queuedPrompt: null,
    recovery: null,
    persistenceRevision: 0
  };
  private readonly listeners = new Set<() => void>();
  private port: MessagePort | null = null;
  private sessionId: string | null = null;
  private nonce: string | null = null;
  private handshakeTimer: number | null = null;
  private preparationTimer: number | null = null;
  private runtimeReady = false;
  private notificationHandle: number | null = null;
  private notificationUsesAnimationFrame = false;
  private loadObserved = false;
  private disposed = false;
  private locale: AiRuntimeLocale;
  private preferences: AiRuntimePreferences;
  private connectionKind: AiRuntimeConnection["kind"] = "fake";
  private readonly workspacePort: AiWorkspaceToolPort | null;
  private readonly pendingToolCalls = new Map<
    string,
    { turnId: string; controller: AbortController }
  >();
  private readonly observedToolCallIds = new Set<string>();
  private readonly observedContentBlockIds = new Set<string>();
  private readonly pendingContentDeltas = new Map<
    string,
    { turnId: string; blockId: string; text: string }
  >();
  private readonly reviewOutcomes = new Map<
    string,
    AiWorkspaceEditReviewOutcome["decision"]
  >();
  private toolCallsThisTurn = 0;

  constructor(
    locale: AiRuntimeLocale,
    workspacePort: AiWorkspaceToolPort | null = null,
    preferences: AiRuntimePreferences = DEFAULT_AI_RUNTIME_PREFERENCES
  ) {
    this.locale = locale;
    this.preferences = { ...preferences };
    this.workspacePort = workspacePort;
    this.conversation = {
      conversationId: secureId("conversation"),
      history: []
    };
    this.snapshot = {
      ...this.snapshot,
      conversationId: this.conversation.conversationId,
      persistenceRevision: 0
    };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  connect(
    frame: HTMLIFrameElement,
    connection: AiRuntimeConnection = { kind: "fake" },
    conversation?: {
      conversationId: string;
      messages: readonly AiTranscriptMessage[];
      history: readonly AiRuntimeConversationHistoryMessage[];
    }
  ) {
    if (this.disposed) return;
    if (this.loadObserved) {
      this.fail("runtime_navigated");
      return;
    }
    this.loadObserved = true;
    this.connectionKind = connection.kind;
    this.runtimeReady = false;
    if (conversation) this.setConversationState(conversation);
    const target = frame.contentWindow;
    if (!target) {
      this.fail("runtime_window_missing");
      return;
    }

    const channel = new MessageChannel();
    const sessionId = secureId("session");
    const nonce = secureId("nonce");
    this.port = channel.port1;
    this.sessionId = sessionId;
    this.nonce = nonce;
    this.port.addEventListener("message", this.handleMessage);
    this.port.start();
    this.setSnapshot({
      status: "handshaking",
      error: null,
      errorMessage: null,
      usage: null,
      managedCatalog: null
    });

    const init: AiRuntimeBootstrapInit = {
      type: "toss.ai.runtime.initialize",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId,
      nonce,
      parentOrigin: window.location.origin,
      locale: this.locale,
      theme: readRuntimeDesignTheme(),
      preferences: { ...this.preferences },
      connection,
      conversation: this.conversation,
      workspace: this.workspacePort
        ? {
            ...this.workspacePort.capabilities,
            tools: [...this.workspacePort.capabilities.tools]
          }
        : null
    };
    target.postMessage(init, "*", [channel.port2]);
    this.handshakeTimer = window.setTimeout(() => {
      this.handshakeTimer = null;
      if (this.snapshot.status === "handshaking") this.fail("runtime_handshake_timeout");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  setLocale(locale: AiRuntimeLocale) {
    if (this.locale === locale) return;
    this.locale = locale;
    if (!this.port || !this.sessionId || this.snapshot.status === "idle") return;
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.set_locale",
      sessionId: this.sessionId,
      locale
    };
    this.port.postMessage(message);
  }

  setPreferences(preferences: AiRuntimePreferences) {
    if (this.snapshot.status === "running" || this.snapshot.status === "handshaking") return false;
    this.preferences = { ...preferences };
    if (this.port && this.sessionId && this.snapshot.status !== "idle") {
      const message: AiHostToRuntimeMessage = {
        type: "toss.ai.host.set_preferences",
        sessionId: this.sessionId,
        preferences: { ...preferences }
      };
      this.port.postMessage(message);
    }
    return true;
  }

  selectManagedModel(selection: AiRuntimeManagedModelSelection) {
    if (
      this.connectionKind !== "managed" ||
      this.snapshot.status === "running" ||
      this.snapshot.status === "handshaking" ||
      !this.port ||
      !this.sessionId
    ) return false;
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.select_managed_model",
      sessionId: this.sessionId,
      selection,
      conversation: {
        conversationId: this.conversation.conversationId,
        history: this.conversation.history.map((item) => ({ ...item }))
      }
    };
    this.port.postMessage(message);
    return true;
  }

  setConversation(
    conversationId: string,
    messages: readonly AiTranscriptMessage[],
    history: readonly AiRuntimeConversationHistoryMessage[]
  ) {
    if (
      this.snapshot.status === "running" ||
      this.snapshot.status === "handshaking" ||
      this.snapshot.queuedPrompt !== null ||
      hasPendingEditReview(this.snapshot.messages)
    ) return false;
    let nextMessages = messages;
    if (this.workspacePort) {
      try {
        const workspace = this.workspacePort.getContextSnapshot();
        nextMessages = reconcilePendingEditReviews(messages, workspace).messages;
      } catch {
        // Keep unresolved review state when Workspace ownership cannot be inspected safely.
      }
    }
    this.setConversationState({ conversationId, messages: nextMessages, history });
    if (this.port && this.sessionId && this.snapshot.status !== "idle") {
      const message: AiHostToRuntimeMessage = {
        type: "toss.ai.host.set_conversation",
        sessionId: this.sessionId,
        conversation: this.conversation
      };
      this.port.postMessage(message);
    }
    return true;
  }

  startTurn(prompt: string, transcriptPrompt: string = prompt) {
    const text = prompt.trim();
    const visibleText = transcriptPrompt.trim() || text;
    if (
      this.snapshot.status !== "ready" ||
      this.snapshot.queuedPrompt !== null ||
      !text ||
      !this.sessionId ||
      !this.port
    ) return false;
    let workspace: AiWorkspaceContextSnapshot | null = null;
    if (this.workspacePort) {
      try {
        workspace = this.workspacePort.getContextSnapshot();
      } catch {
        this.fail("workspace_context_unavailable");
        return false;
      }
      if (
        !isAiWorkspaceContextSnapshot(workspace) ||
        workspace.project_type !== this.workspacePort.capabilities.project_type ||
        workspace.mode !== this.workspacePort.capabilities.mode
      ) {
        this.fail("workspace_context_invalid");
        return false;
      }
      const reconciliation = reconcilePendingEditReviews(this.snapshot.messages, workspace);
      if (reconciliation.changed) {
        this.setSnapshot({ messages: reconciliation.messages }, false, true);
      }
      if (
        workspace.pending_edit_review ||
        hasPendingEditReview(reconciliation.messages)
      ) return false;
    } else if (hasPendingEditReview(this.snapshot.messages)) {
      return false;
    }
    const turnId = secureId("turn");
    const startedAt = Date.now();
    this.abortPendingToolCalls();
    this.observedToolCallIds.clear();
    this.observedContentBlockIds.clear();
    this.toolCallsThisTurn = 0;
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.start_turn",
      sessionId: this.sessionId,
      conversationId: this.conversation.conversationId,
      turnId,
      prompt: text,
      workspace
    };
    this.setSnapshot({
      status: "running",
      activeTurnId: turnId,
      messages: [
        ...this.snapshot.messages,
        {
          id: secureId("user"),
          role: "user",
          parts: [{
            id: secureId("content"),
            type: "text",
            text: visibleText,
            state: "complete",
            startedAt,
            completedAt: startedAt
          }],
          state: "complete",
          startedAt,
          completedAt: startedAt
        },
        {
          id: turnId,
          role: "assistant",
          parts: [],
          state: "streaming",
          startedAt,
          completedAt: null
        }
      ],
      error: null,
      errorMessage: null,
      recovery: null,
      usage: null
    }, false, true);
    this.port.postMessage(message);
    return true;
  }

  submitPrompt(prompt: string) {
    const text = prompt.trim();
    if (!text) return false;
    if (this.snapshot.status === "ready") return this.startTurn(text);
    if (
      this.snapshot.status !== "running" ||
      this.snapshot.queuedPrompt !== null ||
      this.workspaceHasPendingReview() ||
      hasPendingEditReview(this.snapshot.messages)
    ) return false;
    this.setSnapshot({ queuedPrompt: text });
    return true;
  }

  discardQueuedPrompt() {
    if (this.snapshot.queuedPrompt === null) return false;
    this.setSnapshot({ queuedPrompt: null });
    return true;
  }

  recoverTurn(continueLabel?: string) {
    if (this.snapshot.status !== "ready" || !this.snapshot.recovery) return false;
    if (this.snapshot.recovery === "continue") {
      return this.startRecoveryTurn(
        "Continue from the current state without repeating completed work.",
        continueLabel
      );
    }
    const failedAssistantIndex = [...this.snapshot.messages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find(({ message }) => message.role === "assistant" && message.state === "error")?.index;
    if (failedAssistantIndex === undefined) return false;
    const user = this.snapshot.messages[failedAssistantIndex - 1];
    const originalPrompt = user?.role === "user"
      ? user.parts
          .filter((part): part is AiTranscriptContentPart => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : "";
    return this.startRecoveryTurn(originalPrompt);
  }

  cancelTurn() {
    if (this.snapshot.queuedPrompt !== null) this.setSnapshot({ queuedPrompt: null });
    if (!this.port || !this.sessionId || !this.snapshot.activeTurnId) return;
    this.abortPendingToolCalls(this.snapshot.activeTurnId);
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.cancel_turn",
      sessionId: this.sessionId,
      turnId: this.snapshot.activeTurnId
    };
    this.port.postMessage(message);
  }

  resolveEditReview(outcome: AiWorkspaceEditReviewOutcome) {
    let matched = false;
    let changed = false;
    const messages = this.snapshot.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "tool" || part.reviewId !== outcome.reviewId) return part;
        matched = true;
        if (part.outcome !== "review_pending") return part;
        changed = true;
        return { ...part, outcome: outcome.decision };
      })
    }));
    if (changed) {
      this.reviewOutcomes.delete(outcome.reviewId);
      this.setSnapshot({ messages }, false, true);
      queueMicrotask(this.drainQueuedPrompt);
    } else if (!matched) {
      this.reviewOutcomes.set(outcome.reviewId, outcome.decision);
      while (this.reviewOutcomes.size > MAX_BUFFERED_REVIEW_OUTCOMES) {
        const oldest = this.reviewOutcomes.keys().next().value;
        if (typeof oldest !== "string") break;
        this.reviewOutcomes.delete(oldest);
      }
    }
    return changed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.port && this.sessionId) {
      const message: AiHostToRuntimeMessage = {
        type: "toss.ai.host.clear_session",
        sessionId: this.sessionId
      };
      this.port.postMessage(message);
    }
    this.closePort();
    this.cancelScheduledNotification();
    this.reviewOutcomes.clear();
    this.listeners.clear();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    if (!isAiRuntimeToHostMessage(event.data)) {
      this.fail("runtime_message_invalid");
      return;
    }
    const message: AiRuntimeToHostMessage = event.data;
    if (!this.sessionId || message.sessionId !== this.sessionId) {
      this.fail("runtime_session_mismatch");
      return;
    }
    if (message.type === "toss.ai.runtime.bootstrap_ack") {
      if (
        this.snapshot.status !== "handshaking" ||
        message.nonce !== this.nonce ||
        message.protocolVersion !== AI_RUNTIME_PROTOCOL_VERSION ||
        message.buildId !== AI_RUNTIME_BUILD_ID
      ) {
        this.fail("runtime_handshake_invalid");
        return;
      }
      this.clearHandshakeTimer();
      this.preparationTimer = window.setTimeout(() => {
        this.preparationTimer = null;
        if (!this.runtimeReady && this.snapshot.status === "configuring") {
          this.fail("runtime_preparation_timeout");
        }
      }, RUNTIME_PREPARATION_TIMEOUT_MS);
      this.setSnapshot({
        status: "configuring",
        error: null,
        errorMessage: null
      });
      return;
    }
    if (message.type === "toss.ai.runtime.ready") {
      if (
        this.snapshot.status !== "configuring" ||
        this.preparationTimer === null ||
        message.nonce !== this.nonce ||
        message.protocolVersion !== AI_RUNTIME_PROTOCOL_VERSION ||
        message.buildId !== AI_RUNTIME_BUILD_ID
      ) {
        this.fail("runtime_handshake_invalid");
        return;
      }
      this.runtimeReady = true;
      this.clearPreparationTimer();
      this.setSnapshot({
        status: this.connectionKind === "fake" ? "ready" : "configuring",
        error: null,
        errorMessage: null
      });
      return;
    }
    if (message.type === "toss.ai.runtime.error" && !this.runtimeReady) {
      this.fail(message.code);
      return;
    }
    if (
      this.snapshot.status === "handshaking" ||
      this.snapshot.status === "idle" ||
      !this.runtimeReady
    ) {
      this.fail("runtime_message_before_ready");
      return;
    }
    if (message.type === "toss.ai.runtime.tool_call") {
      this.handleToolCall(message);
      return;
    }
    if (message.type === "toss.ai.runtime.tool_cancel") {
      const pending = this.pendingToolCalls.get(message.callId);
      if (pending && pending.turnId === message.turnId) {
        this.pendingToolCalls.delete(message.callId);
        pending.controller.abort();
      }
      this.finishToolPart(message.turnId, message.callId, "cancelled", null, null, null);
      return;
    }
    if (message.type === "toss.ai.runtime.connection_state") {
      if (this.snapshot.status === "running") {
        this.fail("runtime_connection_state_during_turn");
        return;
      }
      this.setSnapshot({
        status: message.state === "ready" ? "ready" : "configuring",
        error: null,
        errorMessage: null
      });
      return;
    }
    if (message.type === "toss.ai.runtime.managed_catalog") {
      if (this.connectionKind !== "managed" || this.snapshot.status === "running") {
        this.fail("runtime_managed_catalog_unexpected");
        return;
      }
      this.setSnapshot({
        managedCatalog: {
          availableRecommendedProfileIds: [...message.availableRecommendedProfileIds],
          models: message.models.map((model) => ({ ...model })),
          selectedModel: message.selectedModel ? { ...message.selectedModel } : null,
          errorCode: message.errorCode ?? null
        }
      });
      return;
    }
    if (message.type === "toss.ai.runtime.content_start") {
      this.handleContentStart(message.turnId, message.blockId, message.kind);
      return;
    }
    if (message.type === "toss.ai.runtime.content_delta") {
      this.handleContentDelta(message.turnId, message.blockId, message.delta);
      return;
    }
    if (message.type === "toss.ai.runtime.content_end") {
      this.handleContentEnd(message.turnId, message.blockId);
      return;
    }
    if (message.type === "toss.ai.runtime.usage") {
      if (message.turnId !== this.snapshot.activeTurnId || this.snapshot.status !== "running") {
        this.fail("runtime_usage_outside_turn");
        return;
      }
      const { type: _type, sessionId: _sessionId, turnId: _turnId, ...usage } = message;
      this.setSnapshot({ usage }, true);
      return;
    }
    if (message.type === "toss.ai.runtime.turn_complete") {
      if (message.turnId !== this.snapshot.activeTurnId) {
        this.fail("runtime_turn_mismatch");
        return;
      }
      const assistantMessage = this.activeAssistantMessage(message.turnId);
      if (!assistantMessage) return;
      if (
        message.outcome === "completed" &&
        assistantMessage.parts.some((part) => part.state === "streaming" || part.state === "running")
      ) {
        this.fail("runtime_turn_completed_with_open_parts");
        return;
      }
      this.abortPendingToolCalls(message.turnId);
      if (message.outcome === "completed") this.recordCompletedTurn(message.turnId);
      this.setSnapshot({
        status: "ready",
        activeTurnId: null,
        messages: replaceMessage(this.snapshot.messages, message.turnId, (item) =>
          settleMessage(item, message.outcome === "cancelled" ? "cancelled" : "complete")
        )
      }, false, true);
      queueMicrotask(this.drainQueuedPrompt);
      return;
    }
    if (message.turnId && message.turnId === this.snapshot.activeTurnId) {
      this.flushContentDeltas();
      const activeMessage = this.snapshot.messages.find((item) => item.id === message.turnId);
      const recovery = message.code === "provider_request_failed" ||
        message.code === "ai_agent_turn_timeout"
        ? activeMessage?.parts.some((part) => (
            part.type === "tool" || part.text.length > 0
          ))
          ? "continue" as const
          : "retry" as const
        : null;
      this.abortPendingToolCalls(message.turnId);
      this.setSnapshot({
        status: "ready",
        activeTurnId: null,
        error: message.code,
        errorMessage: message.message,
        recovery,
        messages: replaceMessage(this.snapshot.messages, message.turnId, (item) =>
          settleMessage(item, "error")
        )
      }, false, true);
      return;
    }
    this.fail(message.code);
  };

  private activeAssistantMessage(turnId: string) {
    if (this.snapshot.status !== "running" || turnId !== this.snapshot.activeTurnId) {
      this.fail("runtime_turn_mismatch");
      return null;
    }
    const message = this.snapshot.messages.find((item) => item.id === turnId);
    if (!message || message.role !== "assistant") {
      this.fail("runtime_turn_message_missing");
      return null;
    }
    return message;
  }

  private setConversationState(conversation: {
    conversationId: string;
    messages: readonly AiTranscriptMessage[];
    history: readonly AiRuntimeConversationHistoryMessage[];
  }) {
    this.abortPendingToolCalls();
    this.observedToolCallIds.clear();
    this.observedContentBlockIds.clear();
    this.pendingContentDeltas.clear();
    this.reviewOutcomes.clear();
    this.toolCallsThisTurn = 0;
    this.conversation = {
      conversationId: conversation.conversationId,
      history: conversation.history.map((message) => ({ ...message }))
    };
    this.setSnapshot({
      conversationId: conversation.conversationId,
      activeTurnId: null,
      messages: [...conversation.messages],
      error: null,
      errorMessage: null,
      usage: null,
      queuedPrompt: null,
      recovery: null,
      managedCatalog: this.connectionKind === "managed"
        ? this.snapshot.managedCatalog
        : null
    });
  }

  private recordCompletedTurn(turnId: string) {
    const assistantIndex = this.snapshot.messages.findIndex((message) => message.id === turnId);
    const assistant = this.snapshot.messages[assistantIndex];
    const user = this.snapshot.messages[assistantIndex - 1];
    if (!assistant || !user || assistant.role !== "assistant" || user.role !== "user") return;
    const boundedContent = (message: AiTranscriptMessage) => {
      const content = message.parts
        .filter((part): part is AiTranscriptContentPart => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
      const limit = AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxContentLength;
      return content.length <= limit
        ? content
        : `${content.slice(0, limit - 1).trimEnd()}…`;
    };
    const userContent = boundedContent(user);
    const assistantContent = boundedContent(assistant);
    if (!userContent || !assistantContent) return;
    const pair = [
      { role: "user" as const, content: userContent, timestamp: user.startedAt },
      { role: "assistant" as const, content: assistantContent, timestamp: assistant.startedAt }
    ];
    if (
      userContent.length + assistantContent.length >
      AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxTotalLength
    ) return;
    const history = [...this.conversation.history, ...pair];
    const totalLength = () => history.reduce((total, item) => total + item.content.length, 0);
    while (
      history.length > AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxMessages ||
      totalLength() > AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxTotalLength
    ) {
      history.splice(0, 2);
    }
    this.conversation = { ...this.conversation, history };
  }

  private handleContentStart(
    turnId: string,
    blockId: string,
    kind: "text" | "reasoning"
  ) {
    const message = this.activeAssistantMessage(turnId);
    if (!message) return;
    if (this.observedContentBlockIds.has(blockId)) {
      this.fail("runtime_content_block_duplicate");
      return;
    }
    this.observedContentBlockIds.add(blockId);
    const part: AiTranscriptContentPart = {
      id: blockId,
      type: kind,
      text: "",
      state: "streaming",
      startedAt: Date.now(),
      completedAt: null
    };
    this.setSnapshot({
      messages: replaceMessage(this.snapshot.messages, turnId, (item) => ({
        ...item,
        parts: [...item.parts, part]
      }))
    }, true);
  }

  private handleContentDelta(turnId: string, blockId: string, delta: string) {
    const message = this.activeAssistantMessage(turnId);
    if (!message) return;
    const part = message.parts.find((item) => item.id === blockId);
    if (
      !part ||
      part.type === "tool" ||
      part.state !== "streaming" ||
      contentLength(message) + this.pendingContentLength(turnId) + delta.length >
        MAX_TRANSCRIPT_MESSAGE_LENGTH
    ) {
      this.fail(part ? "runtime_output_too_large_or_closed" : "runtime_content_block_missing");
      return;
    }
    const key = `${turnId}\u0000${blockId}`;
    const pending = this.pendingContentDeltas.get(key);
    this.pendingContentDeltas.set(key, {
      turnId,
      blockId,
      text: `${pending?.text ?? ""}${delta}`
    });
    this.scheduleNotification();
  }

  private handleContentEnd(turnId: string, blockId: string) {
    this.flushContentDeltas();
    const message = this.activeAssistantMessage(turnId);
    if (!message) return;
    const part = message.parts.find((item) => item.id === blockId);
    if (!part || part.type === "tool" || part.state !== "streaming") {
      this.fail("runtime_content_block_missing_or_closed");
      return;
    }
    const completedAt = Date.now();
    this.setSnapshot({
      messages: replaceMessage(this.snapshot.messages, turnId, (item) =>
        replacePart(item, blockId, (current) => current.type === "tool"
          ? current
          : { ...current, state: "complete", completedAt })
      )
    }, true, true);
  }

  private handleToolCall(message: AiRuntimeToolCall) {
    if (
      this.snapshot.status !== "running" ||
      message.turnId !== this.snapshot.activeTurnId ||
      !this.port ||
      !this.sessionId
    ) {
      this.fail("runtime_tool_call_outside_turn");
      return;
    }
    if (this.observedToolCallIds.has(message.callId)) {
      this.fail("runtime_tool_call_duplicate");
      return;
    }
    this.observedToolCallIds.add(message.callId);
    const presentation = toolPresentation(message);
    const part: AiTranscriptToolPart = {
      id: `tool-${message.callId}`,
      type: "tool",
      tool: message.tool,
      ...presentation,
      reviewId: null,
      state: "running",
      outcome: null,
      errorCode: null,
      startedAt: Date.now(),
      completedAt: null
    };
    this.setSnapshot({
      messages: replaceMessage(this.snapshot.messages, message.turnId, (item) => ({
        ...item,
        parts: [...item.parts, part]
      }))
    }, true);
    this.toolCallsThisTurn += 1;
    if (this.toolCallsThisTurn > AI_WORKSPACE_TOOL_LIMITS.maxToolCallsPerTurn) {
      this.postToolError(message, "workspace_tool_budget_exceeded", "The tool-call budget was exhausted.");
      return;
    }
    if (this.pendingToolCalls.size >= AI_WORKSPACE_TOOL_LIMITS.maxPendingToolCalls) {
      this.postToolError(
        message,
        "workspace_tool_concurrency_exceeded",
        "Too many Workspace tool calls are already running."
      );
      return;
    }
    if (
      !this.workspacePort ||
      !this.workspacePort.capabilities.tools.includes(message.tool)
    ) {
      this.postToolError(
        message,
        "workspace_tool_not_available",
        "The requested Workspace tool is not available in this session."
      );
      return;
    }
    const controller = new AbortController();
    this.pendingToolCalls.set(message.callId, { turnId: message.turnId, controller });
    const request = {
      tool: message.tool,
      arguments: message.arguments
    } as AiWorkspaceToolRequest;
    void Promise.resolve().then(
      () => this.workspacePort!.execute(request, controller.signal)
    ).then((response) => {
      const pending = this.pendingToolCalls.get(message.callId);
      if (!pending || pending.controller !== controller) return;
      this.pendingToolCalls.delete(message.callId);
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.snapshot.status !== "running" ||
        this.snapshot.activeTurnId !== message.turnId
      ) return;
      const safeResponse = isAiWorkspaceToolExecution(message.tool, response)
        ? response
        : {
            outcome: "error" as const,
            error: {
              code: "workspace_tool_internal_error" as const,
              message: "The Workspace tool returned an invalid result."
            }
          };
      this.postToolResponse(message, safeResponse);
    }, () => {
      const pending = this.pendingToolCalls.get(message.callId);
      if (!pending || pending.controller !== controller) return;
      this.pendingToolCalls.delete(message.callId);
      if (controller.signal.aborted) return;
      this.postToolError(
        message,
        "workspace_tool_internal_error",
        "The Workspace tool could not complete safely."
      );
    });
  }

  private postToolError(
    message: AiRuntimeToolCall,
    code: AiWorkspaceToolErrorCode,
    text: string
  ) {
    this.postToolResponse(message, {
      outcome: "error",
      error: { code, message: text }
    });
  }

  private postToolResponse(
    message: AiRuntimeToolCall,
    response: AiWorkspaceToolExecution
  ) {
    const outcome = response.outcome === "success"
      ? ("status" in response.result
          ? response.result.status
          : "success")
      : null;
    const reviewId = response.outcome === "success" &&
      "review_id" in response.result &&
      typeof response.result.review_id === "string"
      ? response.result.review_id
      : null;
    this.finishToolPart(
      message.turnId,
      message.callId,
      response.outcome === "success" ? "complete" : "error",
      outcome,
      response.outcome === "error" ? response.error.code : null,
      reviewId
    );
    if (!this.port || !this.sessionId) return;
    const result: AiHostToRuntimeMessage = {
      type: "toss.ai.host.tool_result",
      sessionId: this.sessionId,
      turnId: message.turnId,
      callId: message.callId,
      tool: message.tool,
      response
    };
    this.port.postMessage(result);
  }

  private finishToolPart(
    turnId: string,
    callId: string,
    state: "complete" | "error" | "cancelled",
    outcome: AiTranscriptToolOutcome | null,
    errorCode: AiWorkspaceToolErrorCode | null,
    reviewId: string | null
  ) {
    this.flushContentDeltas();
    const partId = `tool-${callId}`;
    const message = this.snapshot.messages.find((item) => item.id === turnId);
    const part = message?.parts.find((item) => item.id === partId);
    if (!message || !part || part.type !== "tool" || part.state !== "running") return;
    const completedAt = Date.now();
    const bufferedReviewOutcome = outcome === "review_pending" && reviewId
      ? this.reviewOutcomes.get(reviewId)
      : undefined;
    if (bufferedReviewOutcome && reviewId) this.reviewOutcomes.delete(reviewId);
    const resolvedOutcome = bufferedReviewOutcome ?? outcome;
    this.setSnapshot({
      messages: replaceMessage(this.snapshot.messages, turnId, (item) =>
        replacePart(item, partId, (current) => current.type !== "tool"
          ? current
          : { ...current, state, outcome: resolvedOutcome, errorCode, reviewId, completedAt })
      )
    }, true, true);
  }

  private abortPendingToolCalls(turnId?: string) {
    for (const [callId, pending] of this.pendingToolCalls) {
      if (turnId && pending.turnId !== turnId) continue;
      this.pendingToolCalls.delete(callId);
      pending.controller.abort();
    }
  }

  private readonly drainQueuedPrompt = () => {
    const prompt = this.snapshot.queuedPrompt;
    if (
      !prompt ||
      this.snapshot.status !== "ready" ||
      this.snapshot.error !== null ||
      this.workspaceHasPendingReview() ||
      hasPendingEditReview(this.snapshot.messages)
    ) return;
    this.setSnapshot({ queuedPrompt: null });
    if (!this.startTurn(prompt)) this.setSnapshot({ queuedPrompt: prompt });
  };

  private startRecoveryTurn(prompt: string, transcriptPrompt?: string) {
    const queuedPrompt = this.snapshot.queuedPrompt;
    if (queuedPrompt !== null) this.setSnapshot({ queuedPrompt: null });
    const started = this.startTurn(prompt, transcriptPrompt);
    if (queuedPrompt !== null) this.setSnapshot({ queuedPrompt });
    return started;
  }

  private workspaceHasPendingReview() {
    if (!this.workspacePort) return false;
    try {
      return this.workspacePort.getContextSnapshot().pending_edit_review;
    } catch {
      return true;
    }
  }

  private setSnapshot(
    update: Partial<AiRuntimeSnapshot>,
    deferNotification = false,
    persistenceMilestone = false
  ) {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      persistenceRevision: persistenceMilestone
        ? this.snapshot.persistenceRevision + 1
        : update.persistenceRevision ?? this.snapshot.persistenceRevision
    };
    if (deferNotification) {
      this.scheduleNotification();
      return;
    }
    this.notifyNow();
  }

  private scheduleNotification() {
    if (this.notificationHandle !== null) return;
    if (typeof window.requestAnimationFrame === "function") {
      this.notificationUsesAnimationFrame = true;
      this.notificationHandle = window.requestAnimationFrame(() => {
        this.notificationHandle = null;
        this.notificationUsesAnimationFrame = false;
        this.flushContentDeltas();
        for (const listener of this.listeners) listener();
      });
      return;
    }
    this.notificationUsesAnimationFrame = false;
    this.notificationHandle = window.setTimeout(() => {
      this.notificationHandle = null;
      this.flushContentDeltas();
      for (const listener of this.listeners) listener();
    }, 16);
  }

  private notifyNow() {
    this.cancelScheduledNotification();
    this.flushContentDeltas();
    for (const listener of this.listeners) listener();
  }

  private pendingContentLength(turnId: string) {
    let length = 0;
    for (const pending of this.pendingContentDeltas.values()) {
      if (pending.turnId === turnId) length += pending.text.length;
    }
    return length;
  }

  private flushContentDeltas() {
    if (this.pendingContentDeltas.size === 0) return;
    let messages = this.snapshot.messages;
    for (const { turnId, blockId, text } of this.pendingContentDeltas.values()) {
      messages = replaceMessage(messages, turnId, (message) =>
        replacePart(message, blockId, (part) => part.type === "tool"
          ? part
          : { ...part, text: part.text + text })
      );
    }
    this.pendingContentDeltas.clear();
    this.snapshot = { ...this.snapshot, messages };
  }

  private cancelScheduledNotification() {
    if (this.notificationHandle === null) return;
    if (this.notificationUsesAnimationFrame && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(this.notificationHandle);
    } else {
      window.clearTimeout(this.notificationHandle);
    }
    this.notificationHandle = null;
    this.notificationUsesAnimationFrame = false;
  }

  private fail(code: string) {
    const activeTurnId = this.snapshot.activeTurnId;
    this.abortPendingToolCalls();
    this.closePort();
    this.setSnapshot({
      status: "error",
      activeTurnId: null,
      error: code,
      errorMessage: null,
      messages: activeTurnId
        ? replaceMessage(this.snapshot.messages, activeTurnId, (message) =>
            settleMessage(message, "error")
          )
        : this.snapshot.messages
    }, false, activeTurnId !== null);
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer === null) return;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearPreparationTimer() {
    if (this.preparationTimer === null) return;
    window.clearTimeout(this.preparationTimer);
    this.preparationTimer = null;
  }

  private closePort() {
    this.abortPendingToolCalls();
    this.clearHandshakeTimer();
    this.clearPreparationTimer();
    this.runtimeReady = false;
    this.port?.removeEventListener("message", this.handleMessage);
    this.port?.close();
    this.port = null;
    this.sessionId = null;
    this.nonce = null;
  }
}
