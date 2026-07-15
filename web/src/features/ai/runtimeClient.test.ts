// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  type AiRuntimeBootstrapInit
} from "@/features/ai/protocol";
import { AiRuntimeClient } from "@/features/ai/runtimeClient";

const clients: AiRuntimeClient[] = [];

function nextPortMessage(port: MessagePort) {
  return new Promise<unknown>((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

function runtimeFrame(onBootstrap: (init: AiRuntimeBootstrapInit, port: MessagePort) => void) {
  const postMessage = vi.fn(
    (data: unknown, targetOrigin: string, transfer: Transferable[]) => {
      expect(targetOrigin).toBe("*");
      expect(transfer).toHaveLength(1);
      onBootstrap(data as AiRuntimeBootstrapInit, transfer[0] as MessagePort);
    }
  );
  return {
    frame: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement,
    postMessage
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

describe("AiRuntimeClient", () => {
  it("binds the handshake and projects a complete streamed turn", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    const observed: { bootstrap?: AiRuntimeBootstrapInit } = {};
    const { frame } = runtimeFrame((init, port) => {
      observed.bootstrap = init;
      runtimePort = port;
      port.start();
      port.postMessage({
        type: "toss.ai.runtime.ready",
        protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
        buildId: AI_RUNTIME_BUILD_ID,
        sessionId: init.sessionId,
        nonce: init.nonce
      });
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.connection).toEqual({ kind: "fake" });
    expect(observed.bootstrap?.locale).toBe("en");
    expect(runtimePort).not.toBeNull();

    const localeMessage = nextPortMessage(runtimePort!);
    client.setLocale("zh-CN");
    await expect(localeMessage).resolves.toMatchObject({
      type: "toss.ai.host.set_locale",
      locale: "zh-CN"
    });

    const startMessage = nextPortMessage(runtimePort!);
    expect(client.startTurn("  test turn  ")).toBe(true);
    const start = await startMessage;
    expect(start).toMatchObject({
      type: "toss.ai.host.start_turn",
      prompt: "test turn"
    });
    const turnId = (start as { turnId: string }).turnId;
    const sessionId = observed.bootstrap!.sessionId;
    runtimePort!.postMessage({
      type: "toss.ai.runtime.assistant_delta",
      sessionId,
      turnId,
      text: "done"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId,
      outcome: "completed"
    });

    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(client.getSnapshot().messages).toEqual([
      expect.objectContaining({ role: "user", text: "test turn", state: "complete" }),
      expect.objectContaining({ role: "assistant", text: "done", state: "complete" })
    ]);
  });

  it("fails closed when an initialized frame loads again", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    const { frame, postMessage } = runtimeFrame((init, port) => {
      port.postMessage({
        type: "toss.ai.runtime.ready",
        protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
        buildId: AI_RUNTIME_BUILD_ID,
        sessionId: init.sessionId,
        nonce: init.nonce
      });
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    client.connect(frame);

    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      error: "runtime_navigated"
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects a ready message with the wrong nonce", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    const { frame } = runtimeFrame((init, port) => {
      port.postMessage({
        type: "toss.ai.runtime.ready",
        protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
        buildId: AI_RUNTIME_BUILD_ID,
        sessionId: init.sessionId,
        nonce: "wrong-nonce"
      });
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("error"));
    expect(client.getSnapshot().error).toBe("runtime_handshake_invalid");
  });
});
