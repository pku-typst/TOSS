// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  type AiRuntimeBootstrapInit
} from "@/features/ai/protocol";
import { AiRuntimeClient } from "@/features/ai/runtimeClient";
import type { AiWorkspaceToolPort } from "@/features/ai/toolContract";

const clients: AiRuntimeClient[] = [];

const workspaceContext = {
  schema: 1,
  project_name: "Example",
  project_type: "typst",
  mode: "live",
  entry_file_path: "main.typ",
  active_path: "main.typ",
  access: "read",
  workspace_state: "ready",
  active_document_state: "ready",
  files: { total: 1, text: 1, assets: 0 },
  compilation: { state: "succeeded", errors: 0, warnings: 0 },
  pending_edit_review: false
} as const;

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

function postBootstrapAck(port: MessagePort, init: AiRuntimeBootstrapInit) {
  port.postMessage({
    type: "toss.ai.runtime.bootstrap_ack",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: init.sessionId,
    nonce: init.nonce
  });
}

function postRuntimeReady(port: MessagePort, init: AiRuntimeBootstrapInit) {
  port.postMessage({
    type: "toss.ai.runtime.ready",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: init.sessionId,
    nonce: init.nonce
  });
}

function postRuntimeInitialized(port: MessagePort, init: AiRuntimeBootstrapInit) {
  postBootstrapAck(port, init);
  postRuntimeReady(port, init);
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

describe("AiRuntimeClient", () => {
  it("acknowledges the sandbox before its resources become ready", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let runtimeInit: AiRuntimeBootstrapInit | null = null;
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      runtimeInit = init;
      postBootstrapAck(port, init);
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("configuring"));
    expect(client.startTurn("too early")).toBe(false);
    postRuntimeReady(runtimePort!, runtimeInit!);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
  });

  it("binds the handshake and projects a complete streamed turn", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    const observed: { bootstrap?: AiRuntimeBootstrapInit } = {};
    const { frame } = runtimeFrame((init, port) => {
      observed.bootstrap = init;
      runtimePort = port;
      port.start();
      postRuntimeInitialized(port, init);
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.connection).toEqual({ kind: "fake" });
    expect(observed.bootstrap?.workspace).toBeNull();
    expect(observed.bootstrap?.locale).toBe("en");
    expect(observed.bootstrap?.theme).toMatchObject({ colorScheme: "light" });
    expect(observed.bootstrap?.conversation).toEqual({
      conversationId: client.getSnapshot().conversationId,
      history: []
    });
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
      conversationId: observed.bootstrap?.conversation.conversationId,
      prompt: "test turn",
      workspace: null
    });
    const turnId = (start as { turnId: string }).turnId;
    const sessionId = observed.bootstrap!.sessionId;
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId,
      blockId: "content-0-0",
      kind: "reasoning"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId,
      blockId: "content-0-0",
      delta: "checking"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_end",
      sessionId,
      turnId,
      blockId: "content-0-0"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId,
      blockId: "content-0-1",
      kind: "text"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId,
      blockId: "content-0-1",
      delta: "done"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_end",
      sessionId,
      turnId,
      blockId: "content-0-1"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.usage",
      sessionId,
      turnId,
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      contextTokens: 2_400,
      contextSource: "provider",
      providerCalls: 1,
      reportedCalls: 1,
      inputTokens: 2_000,
      outputTokens: 400,
      reasoningTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2_400,
      compactedMessages: 0
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId,
      outcome: "completed"
    });

    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(client.getSnapshot().messages[0]).toMatchObject({
      role: "user",
      state: "complete",
      parts: [{ type: "text", text: "test turn", state: "complete" }]
    });
    expect(client.getSnapshot().messages[1]).toMatchObject({
      role: "assistant",
      state: "complete",
      parts: [
        { type: "reasoning", text: "checking", state: "complete" },
        { type: "text", text: "done", state: "complete" }
      ]
    });
    expect(client.getSnapshot().usage).toMatchObject({
      contextSource: "provider",
      contextTokens: 2_400,
      inputTokens: 2_000,
      outputTokens: 400
    });
  });

  it("switches transcript and model history without recreating the Runtime", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    const observed: { bootstrap?: AiRuntimeBootstrapInit } = {};
    const restoredMessage = {
      id: "user-restored",
      role: "user" as const,
      parts: [{
        id: "content-restored",
        type: "text" as const,
        text: "restored question",
        state: "complete" as const,
        startedAt: 1,
        completedAt: 1
      }],
      state: "complete" as const,
      startedAt: 1,
      completedAt: 1
    };
    const { frame, postMessage } = runtimeFrame((init, port) => {
      observed.bootstrap = init;
      runtimePort = port;
      port.start();
      postRuntimeInitialized(port, init);
    });

    client.connect(frame, { kind: "fake" }, {
      conversationId: "conversation-1",
      messages: [restoredMessage],
      history: []
    });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.conversation.conversationId).toBe("conversation-1");
    expect(client.getSnapshot().messages).toEqual([restoredMessage]);

    const switchMessage = nextPortMessage(runtimePort!);
    expect(client.setConversation("conversation-2", [], [
      { role: "user", content: "previous question", timestamp: 2 },
      { role: "assistant", content: "previous answer", timestamp: 3 }
    ])).toBe(true);
    await expect(switchMessage).resolves.toMatchObject({
      type: "toss.ai.host.set_conversation",
      conversation: {
        conversationId: "conversation-2",
        history: [
          { role: "user", content: "previous question" },
          { role: "assistant", content: "previous answer" }
        ]
      }
    });
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      conversationId: "conversation-2",
      messages: []
    });

    const startMessage = nextPortMessage(runtimePort!);
    expect(client.startTurn("new question")).toBe(true);
    await expect(startMessage).resolves.toMatchObject({
      type: "toss.ai.host.start_turn",
      conversationId: "conversation-2",
      prompt: "new question"
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an initialized frame loads again", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    const { frame, postMessage } = runtimeFrame((init, port) => {
      postRuntimeInitialized(port, init);
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

  it("fails closed when a completed turn still has an open content block", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      postRuntimeInitialized(port, init);
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    const startMessage = nextPortMessage(runtimePort!);
    expect(client.startTurn("test lifecycle")).toBe(true);
    const { turnId } = await startMessage as { turnId: string };
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId,
      blockId: "content-0-0",
      kind: "text"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId,
      outcome: "completed"
    });

    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("error"));
    expect(client.getSnapshot()).toMatchObject({
      error: "runtime_turn_completed_with_open_parts",
      activeTurnId: null
    });
  });

  it("waits for the endpoint Runtime to accept its in-frame credential", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let runtimeSessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      runtimeSessionId = init.sessionId;
      postRuntimeInitialized(port, init);
      port.postMessage({
        type: "toss.ai.runtime.connection_state",
        sessionId: init.sessionId,
        state: "credential_required"
      });
    });
    client.connect(frame, {
      kind: "endpoint",
      connectionId: "connection-1",
      protocol: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      model: "model-1",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      reasoning: false,
      requestOverrides: {}
    });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("configuring"));
    expect(client.startTurn("not ready")).toBe(false);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.connection_state",
      sessionId: runtimeSessionId,
      state: "ready"
    });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
  });

  it("projects a managed catalog and updates account preferences without recreating the Runtime", async () => {
    const initialPreferences = {
      providerRequestTimeoutMs: 90_000,
      maxProviderCallsPerTurn: 8,
      maxTurnMs: 240_000,
      catalogRequestTimeoutMs: 15_000
    };
    const client = new AiRuntimeClient("en", null, initialPreferences);
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    const observed: { bootstrap?: AiRuntimeBootstrapInit } = {};
    const { frame, postMessage } = runtimeFrame((init, port) => {
      runtimePort = port;
      observed.bootstrap = init;
      postRuntimeInitialized(port, init);
      port.postMessage({
        type: "toss.ai.runtime.connection_state",
        sessionId: init.sessionId,
        state: "discovering_models"
      });
      port.postMessage({
        type: "toss.ai.runtime.managed_catalog",
        sessionId: init.sessionId,
        availableModelProfileIds: ["model-one", "model-two"],
        selectedModelProfileId: "model-one"
      });
      port.postMessage({
        type: "toss.ai.runtime.connection_state",
        sessionId: init.sessionId,
        state: "ready"
      });
    });

    client.connect(frame, { kind: "managed", modelProfileId: "model-one" });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.preferences).toEqual(initialPreferences);
    expect(client.getSnapshot().managedCatalog).toEqual({
      availableModelProfileIds: ["model-one", "model-two"],
      selectedModelProfileId: "model-one",
      errorCode: null
    });

    const modelMessage = nextPortMessage(runtimePort!);
    expect(client.selectManagedModel("model-two")).toBe(true);
    await expect(modelMessage).resolves.toMatchObject({
      type: "toss.ai.host.select_managed_model",
      modelProfileId: "model-two"
    });

    const preferences = {
      ...initialPreferences,
      maxProviderCallsPerTurn: 10
    };
    const preferencesMessage = nextPortMessage(runtimePort!);
    expect(client.setPreferences(preferences)).toBe(true);
    await expect(preferencesMessage).resolves.toMatchObject({
      type: "toss.ai.host.set_preferences",
      preferences
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects a ready message with the wrong nonce", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    const { frame } = runtimeFrame((init, port) => {
      postBootstrapAck(port, init);
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

  it("executes a Runtime tool call through the bounded Workspace port", async () => {
    const workspacePort: AiWorkspaceToolPort = {
      capabilities: {
        project_type: "typst",
        mode: "live",
        tools: ["read_project_file"]
      },
      getContextSnapshot: () => workspaceContext,
      execute: vi.fn(async () => ({
        outcome: "success" as const,
        result: {
          path: "main.typ",
          snapshot_id: "sha256-example",
          start_line: 1,
          end_line: 1,
          total_lines: 1,
          has_more: false,
          content_truncated: false,
          numbered_content: "1 | #set document(title: [Example])"
        }
      }))
    };
    const client = new AiRuntimeClient("en", workspacePort);
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    const observed: { bootstrap?: AiRuntimeBootstrapInit } = {};
    const { frame } = runtimeFrame((init, port) => {
      observed.bootstrap = init;
      runtimePort = port;
      port.start();
      postRuntimeInitialized(port, init);
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.workspace).toEqual(workspacePort.capabilities);
    const startMessage = nextPortMessage(runtimePort!);
    expect(client.startTurn("inspect metadata")).toBe(true);
    const start = await startMessage as { turnId: string };
    expect(start).toMatchObject({ workspace: workspaceContext });
    const resultMessage = nextPortMessage(runtimePort!);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.tool_call",
      sessionId: observed.bootstrap!.sessionId,
      turnId: start.turnId,
      callId: "call-1",
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 20 }
    });

    await expect(resultMessage).resolves.toMatchObject({
      type: "toss.ai.host.tool_result",
      turnId: start.turnId,
      callId: "call-1",
      tool: "read_project_file",
      response: {
        outcome: "success",
        result: { numbered_content: "1 | #set document(title: [Example])" }
      }
    });
    expect(workspacePort.execute).toHaveBeenCalledWith({
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 20 }
    }, expect.any(AbortSignal));
    await vi.waitFor(() => expect(client.getSnapshot().messages.at(-1)?.parts).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "read_project_file",
        path: "main.typ",
        state: "complete",
        outcome: "success"
      })
    ]));
  });
});
