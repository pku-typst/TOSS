import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiRuntimeBootstrapInit,
  type AiRuntimeBootstrapInit,
  type AiRuntimeBootstrapAcknowledged,
  type AiRuntimeError
} from "@/features/ai/protocol";
import {
  earlyRuntimePolicy,
  installRuntimeMetaPolicy,
  lockedRuntimePolicy,
  runtimeConnectSource
} from "@/features/ai/runtimePolicy";
import {
  installBoundAiRuntimeFetch,
  installManagedAiRuntimeFetch
} from "@/ai-runtime/networkPolicy";
import { loadAiProviderStream } from "@/ai-runtime/providerAdapter";
import { readAiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";

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

function acknowledgeBootstrap(
  port: MessagePort,
  init: Pick<AiRuntimeBootstrapInit, "sessionId" | "nonce">
) {
  const acknowledged: AiRuntimeBootstrapAcknowledged = {
    type: "toss.ai.runtime.bootstrap_ack",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: init.sessionId,
    nonce: init.nonce
  };
  port.postMessage(acknowledged);
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
    const policy = readAiRuntimeServerPolicy();
    const network = runtimeConnectSource(event.data.connection, expectedOrigin, policy);
    installRuntimeMetaPolicy(earlyRuntimePolicy(network.source));
    if (policy.kind === "managed_catalog") {
      installManagedAiRuntimeFetch(policy.provider);
    } else if (network.endpoint) {
      installBoundAiRuntimeFetch(network.endpoint);
    }
    acknowledgeBootstrap(port, event.data);
    const [runtime, providerStream] = await Promise.all([
      import("@/ai-runtime/runtime"),
      event.data.connection.kind === "endpoint" || event.data.connection.kind === "managed"
        ? loadAiProviderStream(
            event.data.connection.kind === "endpoint"
              ? event.data.connection.protocol
              : policy.kind === "managed_catalog"
                ? policy.provider.protocol
                : "openai-completions"
          )
        : Promise.resolve(null)
    ]);
    runtime.prepareRuntimeSurface(bootstrapNonce(), event.data.locale);
    await runtime.prepareRuntimeResources(event.data.workspace);
    installRuntimeMetaPolicy(lockedRuntimePolicy(network.source));
    runtime.startRuntime(port, event.data, policy, network.endpoint, providerStream);
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
