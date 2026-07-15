import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiRuntimeBootstrapInit,
  type AiRuntimeError
} from "@/features/ai/protocol";
import {
  earlyRuntimePolicy,
  installRuntimeMetaPolicy,
  lockedRuntimePolicy,
  runtimeConnectSource
} from "@/features/ai/runtimePolicy";

let initialized = false;

function bootstrapNonce() {
  return document.querySelector<HTMLScriptElement>(
    "script[data-toss-ai-bootstrap='true']"
  )?.nonce ?? "";
}

function expectedApplicationOrigin() {
  return new URL(window.location.href).origin;
}

function reportBootstrapFailure(port: MessagePort, sessionId: string, message: string) {
  const error: AiRuntimeError = {
    type: "toss.ai.runtime.error",
    sessionId,
    code: "runtime_bootstrap_failed",
    message: message.slice(0, 1_024)
  };
  port.postMessage(error);
}

async function initialize(event: MessageEvent<unknown>) {
  if (initialized || event.source !== window.parent || event.ports.length !== 1) return;
  if (!isAiRuntimeBootstrapInit(event.data)) return;
  const expectedOrigin = expectedApplicationOrigin();
  if (event.origin !== expectedOrigin || event.data.parentOrigin !== expectedOrigin) return;

  initialized = true;
  window.removeEventListener("message", initialize);
  const port = event.ports[0];
  port.start();

  try {
    const network = runtimeConnectSource(event.data.connection, expectedOrigin);
    installRuntimeMetaPolicy(earlyRuntimePolicy(network.source));
    const runtime = await import("@/ai-runtime/runtime");
    runtime.prepareRuntimeSurface(bootstrapNonce(), event.data.locale);
    installRuntimeMetaPolicy(lockedRuntimePolicy(network.source));
    runtime.startRuntime(port, event.data, network.endpoint);
  } catch (error) {
    reportBootstrapFailure(
      port,
      event.data.sessionId,
      error instanceof Error ? error.message : "runtime_bootstrap_failed"
    );
    port.close();
  }
}

window.addEventListener("message", initialize);

document.documentElement.dataset.runtimeProtocol = String(AI_RUNTIME_PROTOCOL_VERSION);
document.documentElement.dataset.runtimeBuild = AI_RUNTIME_BUILD_ID;
