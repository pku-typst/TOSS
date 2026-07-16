import { describe, expect, it } from "vitest";
import { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";

function nextPortMessage(port: MessagePort) {
  return new Promise<unknown>((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

describe("AiRuntimeToolBridge", () => {
  it("propagates aborts to the Host and rejects the pending tool", async () => {
    const channel = new MessageChannel();
    const bridge = new AiRuntimeToolBridge(channel.port1, "session-1");
    channel.port1.start();
    channel.port2.start();
    bridge.beginTurn("turn-1");
    const controller = new AbortController();
    const requestMessage = nextPortMessage(channel.port2);
    const result = bridge.call({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    }, controller.signal);
    const request = await requestMessage as { callId: string };
    const cancelMessage = nextPortMessage(channel.port2);
    const rejected = expect(result).rejects.toMatchObject({
      code: "workspace_request_cancelled"
    });

    controller.abort();

    await expect(cancelMessage).resolves.toMatchObject({
      type: "toss.ai.runtime.tool_cancel",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: request.callId
    });
    await rejected;
    bridge.endTurn("turn-1");
    bridge.dispose();
    channel.port1.close();
    channel.port2.close();
  });
});
