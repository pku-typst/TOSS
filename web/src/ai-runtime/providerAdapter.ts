import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AiRuntimeProviderProtocol } from "@/features/ai/protocol";

type ProtocolModule = {
  streamSimple: StreamFn;
};

export async function loadAiProviderStream(
  protocol: AiRuntimeProviderProtocol
): Promise<StreamFn> {
  let module: ProtocolModule;
  if (protocol === "openai-completions") {
    module = await import("@earendil-works/pi-ai/api/openai-completions") as unknown as ProtocolModule;
  } else if (protocol === "openai-responses") {
    module = await import("@earendil-works/pi-ai/api/openai-responses") as unknown as ProtocolModule;
  } else {
    module = await import("@earendil-works/pi-ai/api/anthropic-messages") as unknown as ProtocolModule;
  }
  return module.streamSimple;
}
