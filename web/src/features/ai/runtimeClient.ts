import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiRuntimeToHostMessage,
  type AiHostToRuntimeMessage,
  type AiRuntimeBootstrapInit,
  type AiRuntimeConnection,
  type AiRuntimeLocale,
  type AiRuntimeToHostMessage
} from "@/features/ai/protocol";

export type AiRuntimeStatus = "idle" | "handshaking" | "ready" | "running" | "error";

export type AiTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: "complete" | "streaming" | "cancelled" | "error";
};

export type AiRuntimeSnapshot = {
  status: AiRuntimeStatus;
  messages: readonly AiTranscriptMessage[];
  activeTurnId: string | null;
  error: string | null;
};

const HANDSHAKE_TIMEOUT_MS = 5_000;
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

export class AiRuntimeClient {
  private snapshot: AiRuntimeSnapshot = {
    status: "idle",
    messages: [],
    activeTurnId: null,
    error: null
  };
  private readonly listeners = new Set<() => void>();
  private port: MessagePort | null = null;
  private sessionId: string | null = null;
  private nonce: string | null = null;
  private handshakeTimer: number | null = null;
  private loadObserved = false;
  private disposed = false;
  private locale: AiRuntimeLocale;

  constructor(locale: AiRuntimeLocale) {
    this.locale = locale;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  connect(frame: HTMLIFrameElement, connection: AiRuntimeConnection = { kind: "fake" }) {
    if (this.disposed) return;
    if (this.loadObserved) {
      this.fail("runtime_navigated");
      return;
    }
    this.loadObserved = true;
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
    this.setSnapshot({ status: "handshaking", error: null });

    const init: AiRuntimeBootstrapInit = {
      type: "toss.ai.runtime.initialize",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId,
      nonce,
      parentOrigin: window.location.origin,
      locale: this.locale,
      connection
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

  startTurn(prompt: string) {
    const text = prompt.trim();
    if (this.snapshot.status !== "ready" || !text || !this.sessionId || !this.port) return false;
    const turnId = secureId("turn");
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.start_turn",
      sessionId: this.sessionId,
      turnId,
      prompt: text
    };
    this.setSnapshot({
      status: "running",
      activeTurnId: turnId,
      messages: [
        ...this.snapshot.messages,
        { id: secureId("user"), role: "user", text, state: "complete" },
        { id: turnId, role: "assistant", text: "", state: "streaming" }
      ],
      error: null
    });
    this.port.postMessage(message);
    return true;
  }

  cancelTurn() {
    if (!this.port || !this.sessionId || !this.snapshot.activeTurnId) return;
    const message: AiHostToRuntimeMessage = {
      type: "toss.ai.host.cancel_turn",
      sessionId: this.sessionId,
      turnId: this.snapshot.activeTurnId
    };
    this.port.postMessage(message);
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
    if (message.type === "toss.ai.runtime.ready") {
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
      this.setSnapshot({ status: "ready", error: null });
      return;
    }
    if (this.snapshot.status === "handshaking" || this.snapshot.status === "idle") {
      this.fail("runtime_message_before_ready");
      return;
    }
    if (message.type === "toss.ai.runtime.assistant_delta") {
      if (message.turnId !== this.snapshot.activeTurnId) {
        this.fail("runtime_turn_mismatch");
        return;
      }
      const current = this.snapshot.messages.find((item) => item.id === message.turnId);
      if (!current || current.text.length + message.text.length > MAX_TRANSCRIPT_MESSAGE_LENGTH) {
        this.fail("runtime_output_too_large");
        return;
      }
      this.setSnapshot({
        messages: replaceMessage(this.snapshot.messages, message.turnId, (item) => ({
          ...item,
          text: item.text + message.text
        }))
      });
      return;
    }
    if (message.type === "toss.ai.runtime.turn_complete") {
      if (message.turnId !== this.snapshot.activeTurnId) {
        this.fail("runtime_turn_mismatch");
        return;
      }
      this.setSnapshot({
        status: "ready",
        activeTurnId: null,
        messages: replaceMessage(this.snapshot.messages, message.turnId, (item) => ({
          ...item,
          state: message.outcome === "cancelled" ? "cancelled" : "complete"
        }))
      });
      return;
    }
    if (message.turnId && message.turnId === this.snapshot.activeTurnId) {
      this.setSnapshot({
        status: "ready",
        activeTurnId: null,
        error: message.code,
        messages: replaceMessage(this.snapshot.messages, message.turnId, (item) => ({
          ...item,
          state: "error"
        }))
      });
      return;
    }
    this.fail(message.code);
  };

  private setSnapshot(update: Partial<AiRuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  private fail(code: string) {
    const activeTurnId = this.snapshot.activeTurnId;
    this.closePort();
    this.setSnapshot({
      status: "error",
      activeTurnId: null,
      error: code,
      messages: activeTurnId
        ? replaceMessage(this.snapshot.messages, activeTurnId, (message) => ({
            ...message,
            state: "error"
          }))
        : this.snapshot.messages
    });
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer === null) return;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private closePort() {
    this.clearHandshakeTimer();
    this.port?.removeEventListener("message", this.handleMessage);
    this.port?.close();
    this.port = null;
    this.sessionId = null;
    this.nonce = null;
  }
}
