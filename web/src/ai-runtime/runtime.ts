import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiHostToRuntimeMessage,
  type AiHostToRuntimeMessage,
  type AiRuntimeBootstrapInit,
  type AiRuntimeError,
  type AiRuntimeLocale,
  type AiRuntimeToHostMessage
} from "@/features/ai/protocol";
import type { NormalizedAiEndpoint } from "@/features/ai/runtimePolicy";
import {
  aiRuntimeMessages,
  type AiRuntimeStatusMessage
} from "@/ai-runtime/i18n";

let runtimeLabel: HTMLElement | null = null;
let runtimeStatus: HTMLElement | null = null;
let runtimeLocale: AiRuntimeLocale = "en";
let runtimeStatusMessage: AiRuntimeStatusMessage = "handshaking";

function renderRuntimeSurface() {
  const messages = aiRuntimeMessages(runtimeLocale);
  document.documentElement.lang = runtimeLocale;
  if (runtimeLabel) runtimeLabel.textContent = messages.label;
  if (runtimeStatus) runtimeStatus.textContent = messages.status[runtimeStatusMessage];
}

function setRuntimeStatus(message: AiRuntimeStatusMessage) {
  runtimeStatusMessage = message;
  renderRuntimeSurface();
}

function setRuntimeLocale(locale: AiRuntimeLocale) {
  runtimeLocale = locale;
  renderRuntimeSurface();
}

export function prepareRuntimeSurface(nonce: string, locale: AiRuntimeLocale) {
  const style = document.createElement("style");
  style.nonce = nonce;
  style.textContent = `
    :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-width: 0; background: transparent; color: CanvasText; }
    #ai-runtime-root { box-sizing: border-box; display: grid; gap: 4px; padding: 10px 12px; }
    .runtime-label { margin: 0; font-size: 12px; font-weight: 650; }
    .runtime-status { margin: 0; font-size: 11px; opacity: 0.72; }
  `;
  document.head.append(style);

  const root = document.getElementById("ai-runtime-root");
  if (!root) throw new Error("ai_runtime_root_missing");
  root.replaceChildren();
  runtimeLabel = document.createElement("p");
  runtimeLabel.className = "runtime-label";
  runtimeStatus = document.createElement("p");
  runtimeStatus.className = "runtime-status";
  root.append(runtimeLabel, runtimeStatus);
  setRuntimeLocale(locale);
}

function post(port: MessagePort, message: AiRuntimeToHostMessage) {
  port.postMessage(message);
}

export function startRuntime(
  port: MessagePort,
  init: AiRuntimeBootstrapInit,
  endpoint: NormalizedAiEndpoint | null
) {
  let activeTurnId: string | null = null;
  let timers: number[] = [];

  const clearTimers = () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  };

  const fail = (code: string, message: string, turnId?: string) => {
    const error: AiRuntimeError = {
      type: "toss.ai.runtime.error",
      sessionId: init.sessionId,
      ...(turnId ? { turnId } : {}),
      code,
      message
    };
    post(port, error);
  };

  const complete = (turnId: string, outcome: "completed" | "cancelled") => {
    activeTurnId = null;
    setRuntimeStatus(
      outcome === "cancelled"
        ? "readyAfterCancellation"
        : "ready"
    );
    post(port, {
      type: "toss.ai.runtime.turn_complete",
      sessionId: init.sessionId,
      turnId,
      outcome
    });
  };

  const startFakeTurn = (turnId: string) => {
    if (activeTurnId) {
      fail(
        "runtime_turn_in_progress",
        aiRuntimeMessages(runtimeLocale).errors.turnInProgress,
        turnId
      );
      return;
    }
    activeTurnId = turnId;
    setRuntimeStatus("running");
    const fakeResponse = aiRuntimeMessages(runtimeLocale).fakeResponse;
    fakeResponse.forEach((text, index) => {
      timers.push(
        window.setTimeout(() => {
          if (activeTurnId !== turnId) return;
          setRuntimeStatus("streaming");
          post(port, {
            type: "toss.ai.runtime.assistant_delta",
            sessionId: init.sessionId,
            turnId,
            text
          });
          if (index === fakeResponse.length - 1) complete(turnId, "completed");
        }, 40 * (index + 1))
      );
    });
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!isAiHostToRuntimeMessage(event.data)) {
      setRuntimeStatus("invalidHostMessage");
      fail(
        "runtime_message_invalid",
        aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage
      );
      return;
    }
    const message: AiHostToRuntimeMessage = event.data;
    if (message.sessionId !== init.sessionId) return;
    if (message.type === "toss.ai.host.set_locale") {
      setRuntimeLocale(message.locale);
      return;
    }
    if (message.type === "toss.ai.host.start_turn") {
      if (init.connection.kind !== "fake" || endpoint) {
        fail(
          "runtime_provider_not_implemented",
          aiRuntimeMessages(runtimeLocale).errors.providerNotImplemented,
          message.turnId
        );
        return;
      }
      startFakeTurn(message.turnId);
      return;
    }
    if (message.type === "toss.ai.host.cancel_turn") {
      if (activeTurnId !== message.turnId) return;
      clearTimers();
      complete(message.turnId, "cancelled");
      return;
    }
    clearTimers();
    activeTurnId = null;
  };

  port.addEventListener("message", handleMessage);
  port.start();
  setRuntimeStatus("ready");
  post(port, {
    type: "toss.ai.runtime.ready",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: init.sessionId,
    nonce: init.nonce
  });
}
