import {
  AI_WORKSPACE_TOOL_LIMITS,
  isAiTypstPackageToolName,
  type AiWorkspaceToolErrorCode,
  type AiWorkspaceToolRequest,
  type AiWorkspaceToolResult
} from "@/features/ai/toolContract";
import type {
  AiHostToolResult,
  AiRuntimeToolCall,
  AiRuntimeToolCancel
} from "@/features/ai/protocol";
import { aiRuntimeMessages } from "@/ai-runtime/i18n";
import type { AiRuntimeLocale } from "@/features/ai/protocol";

const TOOL_CALL_TIMEOUT_MS = 20_000;
const PACKAGE_TOOL_CALL_TIMEOUT_MS = 60_000;
const REVIEW_TOOL_CALL_TIMEOUT_MS = 290_000;

type PendingToolCall = {
  turnId: string;
  tool: AiWorkspaceToolRequest["tool"];
  resolve: (result: AiWorkspaceToolResult) => void;
  reject: (error: AiRuntimeToolCallError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  abort: (() => void) | null;
};

export class AiRuntimeToolCallError extends Error {
  readonly code: AiWorkspaceToolErrorCode;

  constructor(code: AiWorkspaceToolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AiRuntimeToolCallError";
    this.code = code;
  }
}

function secureCallId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `tool-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export class AiRuntimeToolBridge {
  private readonly pending = new Map<string, PendingToolCall>();
  private readonly observedCallIds = new Set<string>();
  private activeTurnId: string | null = null;
  private callCount = 0;
  private disposed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly sessionId: string,
    private readonly getLocale: () => AiRuntimeLocale = () => "en"
  ) {}

  beginTurn(turnId: string) {
    if (this.disposed) throw new Error("ai_runtime_tool_bridge_disposed");
    if (this.activeTurnId || this.pending.size > 0) {
      throw new Error("ai_runtime_tool_turn_in_progress");
    }
    this.activeTurnId = turnId;
    this.callCount = 0;
    this.observedCallIds.clear();
  }

  endTurn(turnId: string) {
    if (this.activeTurnId !== turnId) return;
    this.cancelPendingForTurn(turnId, true);
    this.activeTurnId = null;
  }

  call(request: AiWorkspaceToolRequest, signal?: AbortSignal) {
    const messages = aiRuntimeMessages(this.getLocale()).toolErrors;
    if (this.disposed || !this.activeTurnId) {
      return Promise.reject(new AiRuntimeToolCallError(
        "workspace_tool_not_available",
        messages.inactive
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new AiRuntimeToolCallError(
        "workspace_request_cancelled",
        messages.cancelled
      ));
    }
    this.callCount += 1;
    if (this.callCount > AI_WORKSPACE_TOOL_LIMITS.maxToolCallsPerTurn) {
      return Promise.reject(new AiRuntimeToolCallError(
        "workspace_tool_budget_exceeded",
        messages.budget
      ));
    }
    if (this.pending.size >= AI_WORKSPACE_TOOL_LIMITS.maxPendingToolCalls) {
      return Promise.reject(new AiRuntimeToolCallError(
        "workspace_tool_concurrency_exceeded",
        messages.concurrency
      ));
    }
    const turnId = this.activeTurnId;
    const callId = secureCallId();
    this.observedCallIds.add(callId);
    return new Promise<AiWorkspaceToolResult>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.cancelCall(
          callId,
          new AiRuntimeToolCallError(
            "workspace_tool_internal_error",
            aiRuntimeMessages(this.getLocale()).toolErrors.timeout
          ),
          true
        );
      }, request.tool === "apply_patch" || request.tool === "write_file"
        ? REVIEW_TOOL_CALL_TIMEOUT_MS
        : isAiTypstPackageToolName(request.tool)
          ? PACKAGE_TOOL_CALL_TIMEOUT_MS
          : TOOL_CALL_TIMEOUT_MS);
      const abort = signal
        ? () => this.cancelCall(
            callId,
            new AiRuntimeToolCallError(
              "workspace_request_cancelled",
              aiRuntimeMessages(this.getLocale()).toolErrors.cancelled
            ),
            true
          )
        : null;
      if (abort) signal!.addEventListener("abort", abort, { once: true });
      this.pending.set(callId, {
        turnId,
        tool: request.tool,
        resolve,
        reject,
        timer,
        signal,
        abort
      });
      if (signal?.aborted) {
        this.cancelCall(
          callId,
          new AiRuntimeToolCallError(
            "workspace_request_cancelled",
            aiRuntimeMessages(this.getLocale()).toolErrors.cancelled
          ),
          false
        );
        return;
      }
      const message: AiRuntimeToolCall = {
        type: "toss.ai.runtime.tool_call",
        sessionId: this.sessionId,
        turnId,
        callId,
        tool: request.tool,
        arguments: request.arguments
      } as AiRuntimeToolCall;
      this.port.postMessage(message);
    });
  }

  handleResult(message: AiHostToolResult) {
    const pending = this.pending.get(message.callId);
    if (!pending) return this.observedCallIds.has(message.callId);
    if (
      message.turnId !== pending.turnId ||
      message.tool !== pending.tool ||
      message.turnId !== this.activeTurnId
    ) {
      this.cancelCall(
        message.callId,
        new AiRuntimeToolCallError(
          "workspace_tool_internal_error",
          aiRuntimeMessages(this.getLocale()).toolErrors.mismatch
        ),
        true
      );
      return false;
    }
    this.finishPending(message.callId);
    if (message.response.outcome === "error") {
      pending.reject(new AiRuntimeToolCallError(
        message.response.error.code,
        message.response.error.message
      ));
    } else {
      pending.resolve(message.response.result);
    }
    return true;
  }

  cancelTurn(turnId: string) {
    this.cancelPendingForTurn(turnId, true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeTurnId) this.cancelPendingForTurn(this.activeTurnId, true);
    this.activeTurnId = null;
  }

  private cancelPendingForTurn(turnId: string, notifyHost: boolean) {
    for (const [callId, pending] of this.pending) {
      if (pending.turnId !== turnId) continue;
      this.cancelCall(
        callId,
        new AiRuntimeToolCallError(
          "workspace_request_cancelled",
          aiRuntimeMessages(this.getLocale()).toolErrors.cancelled
        ),
        notifyHost
      );
    }
  }

  private cancelCall(
    callId: string,
    error: AiRuntimeToolCallError,
    notifyHost: boolean
  ) {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.finishPending(callId);
    if (notifyHost) {
      const message: AiRuntimeToolCancel = {
        type: "toss.ai.runtime.tool_cancel",
        sessionId: this.sessionId,
        turnId: pending.turnId,
        callId
      };
      this.port.postMessage(message);
    }
    pending.reject(error);
  }

  private finishPending(callId: string) {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    globalThis.clearTimeout(pending.timer);
    if (pending.abort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }
}
