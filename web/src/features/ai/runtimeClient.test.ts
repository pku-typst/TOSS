// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  type AiRuntimeBootstrapInit
} from "@/features/ai/protocol";
import {
  AiRuntimeClient,
  type AiTranscriptMessage
} from "@/features/ai/runtimeClient";
import type {
  AiWorkspaceContextSnapshot,
  AiWorkspaceToolPort
} from "@/features/ai/toolContract";

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
  pending_edit_review: false,
  last_edit_review: null
} as const;

function pendingReviewTranscript(reviewId: string): AiTranscriptMessage[] {
  return [{
    id: "assistant-review",
    role: "assistant",
    parts: [{
      id: "tool-review",
      type: "tool",
      tool: "apply_patch",
      path: "main.typ",
      query: null,
      startLine: null,
      endLine: null,
      reviewId,
      state: "complete",
      outcome: "review_pending",
      errorCode: null,
      startedAt: 1,
      completedAt: 2
    }],
    state: "complete",
    startedAt: 1,
    completedAt: 2
  }];
}

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
  it("reconciles a restored review that no longer has a Workspace owner", () => {
    let lastEditReview: AiWorkspaceContextSnapshot["last_edit_review"] = null;
    const workspacePort: AiWorkspaceToolPort = {
      capabilities: { project_type: "typst", mode: "live", tools: ["apply_patch"] },
      getContextSnapshot: () => ({
        ...workspaceContext,
        access: "edit" as const,
        last_edit_review: lastEditReview
      }),
      execute: vi.fn(),
      dispose: vi.fn()
    };
    const client = new AiRuntimeClient("en", workspacePort);
    clients.push(client);

    expect(client.setConversation(
      "restored-orphan",
      pendingReviewTranscript("review-orphan"),
      []
    )).toBe(true);
    expect(client.getSnapshot().messages[0]?.parts[0]).toMatchObject({
      reviewId: "review-orphan",
      outcome: "cancelled"
    });

    lastEditReview = { review_id: "review-accepted", decision: "accepted" };
    expect(client.setConversation(
      "restored-accepted",
      pendingReviewTranscript("review-accepted"),
      []
    )).toBe(true);
    expect(client.getSnapshot().messages[0]?.parts[0]).toMatchObject({
      reviewId: "review-accepted",
      outcome: "accepted"
    });
  });

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
        availableRecommendedProfileIds: ["model-one", "model-two"],
        models: [
          { id: "vendor/model-one" },
          { id: "vendor/model-two" }
        ],
        selectedModel: { kind: "recommended", profileId: "model-one" }
      });
      port.postMessage({
        type: "toss.ai.runtime.connection_state",
        sessionId: init.sessionId,
        state: "ready"
      });
    });

    client.connect(frame, {
      kind: "managed",
      selection: { kind: "recommended", profileId: "model-one" }
    });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(observed.bootstrap?.preferences).toEqual(initialPreferences);
    expect(client.getSnapshot().managedCatalog).toEqual({
      availableRecommendedProfileIds: ["model-one", "model-two"],
      models: [
        { id: "vendor/model-one" },
        { id: "vendor/model-two" }
      ],
      selectedModel: { kind: "recommended", profileId: "model-one" },
      errorCode: null
    });

    const modelMessage = nextPortMessage(runtimePort!);
    expect(client.selectManagedModel({
      kind: "recommended",
      profileId: "model-two"
    })).toBe(true);
    await expect(modelMessage).resolves.toMatchObject({
      type: "toss.ai.host.select_managed_model",
      selection: { kind: "recommended", profileId: "model-two" }
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
      dispose: vi.fn(),
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

  it("settles the Agent turn while Workspace review remains pending", async () => {
    let lastEditReview: AiWorkspaceContextSnapshot["last_edit_review"] = null;
    let reviewPending = false;
    const workspacePort: AiWorkspaceToolPort = {
      capabilities: {
        project_type: "typst",
        mode: "live",
        tools: ["apply_patch"]
      },
      getContextSnapshot: () => ({
        ...workspaceContext,
        access: "edit" as const,
        pending_edit_review: reviewPending,
        last_edit_review: lastEditReview
      }),
      dispose: vi.fn(),
      execute: vi.fn(async () => {
        reviewPending = true;
        return {
          outcome: "success" as const,
          result: {
            path: "main.typ",
            base_snapshot: "sha256-base",
            status: "review_pending" as const,
            review_id: "review-1",
            verification: {
              status: "passed" as const,
              errors: [],
              diagnostics: [],
              truncated: false
            }
          }
        };
      })
    };
    const client = new AiRuntimeClient("en", workspacePort);
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      port.start();
      postRuntimeInitialized(port, init);
    });

    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    const startMessage = nextPortMessage(runtimePort!);
    expect(client.startTurn("update the title")).toBe(true);
    const { turnId } = await startMessage as { turnId: string };
    const resultMessage = nextPortMessage(runtimePort!);
    expect(client.submitPrompt("explain the accepted result")).toBe(true);
    expect(client.getSnapshot().queuedPrompt).toBe("explain the accepted result");
    runtimePort!.postMessage({
      type: "toss.ai.runtime.tool_call",
      sessionId,
      turnId,
      callId: "call-review",
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: "sha256-base",
        patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1 +1 @@\n-= Old\n+= New"
      }
    });

    await expect(resultMessage).resolves.toMatchObject({
      type: "toss.ai.host.tool_result",
      response: { outcome: "success", result: { status: "review_pending" } }
    });
    await vi.waitFor(() => expect(client.getSnapshot().messages.at(-1)?.parts).toEqual([
      expect.objectContaining({
        type: "tool",
        reviewId: "review-1",
        state: "complete",
        outcome: "review_pending"
      })
    ]));

    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId,
      outcome: "completed"
    });
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    expect(client.getSnapshot().queuedPrompt).toBe("explain the accepted result");
    reviewPending = false;
    expect(client.startTurn("bypass review")).toBe(false);
    const queuedStartMessage = nextPortMessage(runtimePort!);
    lastEditReview = { review_id: "review-1", decision: "accepted" };
    expect(client.resolveEditReview({
      reviewId: "review-1",
      decision: "accepted",
      decidedAt: 100
    })).toBe(true);
    expect(client.getSnapshot().messages.at(-1)?.parts).toEqual([
      expect.objectContaining({ outcome: "accepted", reviewId: "review-1" })
    ]);
    await expect(queuedStartMessage).resolves.toMatchObject({
      type: "toss.ai.host.start_turn",
      prompt: "explain the accepted result",
      workspace: {
        last_edit_review: { review_id: "review-1", decision: "accepted" }
      }
    });
    expect(client.getSnapshot()).toMatchObject({ status: "running", queuedPrompt: null });
  });

  it("retains a review outcome that arrives before the tool result", async () => {
    let completeExecution!: (value: Awaited<ReturnType<AiWorkspaceToolPort["execute"]>>) => void;
    const execution = new Promise<Awaited<ReturnType<AiWorkspaceToolPort["execute"]>>>((resolve) => {
      completeExecution = resolve;
    });
    const workspacePort: AiWorkspaceToolPort = {
      capabilities: { project_type: "typst", mode: "live", tools: ["write_file"] },
      getContextSnapshot: () => ({ ...workspaceContext, access: "edit" as const }),
      dispose: vi.fn(),
      execute: vi.fn(() => execution)
    };
    const client = new AiRuntimeClient("en", workspacePort);
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      port.start();
      postRuntimeInitialized(port, init);
    });
    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    const startMessage = nextPortMessage(runtimePort!);
    client.startTurn("rewrite the file");
    const { turnId } = await startMessage as { turnId: string };
    const resultMessage = nextPortMessage(runtimePort!);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.tool_call",
      sessionId,
      turnId,
      callId: "call-race",
      tool: "write_file",
      arguments: { path: "main.typ", base_snapshot: "sha256-base", content: "= New" }
    });
    await vi.waitFor(() => expect(workspacePort.execute).toHaveBeenCalledOnce());
    expect(client.resolveEditReview({
      reviewId: "review-race",
      decision: "rejected",
      decidedAt: 100
    })).toBe(false);
    completeExecution({
      outcome: "success",
      result: {
        path: "main.typ",
        base_snapshot: "sha256-base",
        status: "review_pending",
        review_id: "review-race",
        verification: { status: "passed", errors: [], diagnostics: [], truncated: false }
      }
    });
    await resultMessage;
    await vi.waitFor(() => expect(client.getSnapshot().messages.at(-1)?.parts).toEqual([
      expect.objectContaining({ outcome: "rejected", reviewId: "review-race" })
    ]));
  });

  it("queues one prompt and starts it after a normal safe turn boundary", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      port.start();
      postRuntimeInitialized(port, init);
    });
    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
    const firstStart = nextPortMessage(runtimePort!);
    expect(client.submitPrompt("first request")).toBe(true);
    const { turnId } = await firstStart as { turnId: string };
    expect(client.submitPrompt("queued request")).toBe(true);
    expect(client.submitPrompt("too many")).toBe(false);
    const secondStart = nextPortMessage(runtimePort!);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId,
      blockId: "content-0-0",
      kind: "text"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId,
      blockId: "content-0-0",
      delta: "first response"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_end",
      sessionId,
      turnId,
      blockId: "content-0-0"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId,
      outcome: "completed"
    });

    await expect(secondStart).resolves.toMatchObject({
      type: "toss.ai.host.start_turn",
      prompt: "queued request"
    });
    expect(client.getSnapshot()).toMatchObject({ status: "running", queuedPrompt: null });
  });

  it("offers retry before semantic output and continue after partial output", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      port.start();
      postRuntimeInitialized(port, init);
    });
    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));

    const failedStart = nextPortMessage(runtimePort!);
    client.startTurn("original request");
    const failedTurn = await failedStart as { turnId: string };
    runtimePort!.postMessage({
      type: "toss.ai.runtime.error",
      sessionId,
      turnId: failedTurn.turnId,
      code: "provider_request_failed",
      message: "Provider request failed."
    });
    await vi.waitFor(() => expect(client.getSnapshot().recovery).toBe("retry"));
    const retryStart = nextPortMessage(runtimePort!);
    expect(client.recoverTurn()).toBe(true);
    const retryTurn = await retryStart as { turnId: string; prompt: string };
    expect(retryTurn.prompt).toBe("original request");

    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId: retryTurn.turnId,
      blockId: "content-0-0",
      kind: "text"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId: retryTurn.turnId,
      blockId: "content-0-0",
      delta: "partial result"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.error",
      sessionId,
      turnId: retryTurn.turnId,
      code: "provider_request_failed",
      message: "Provider stream failed."
    });
    await vi.waitFor(() => expect(client.getSnapshot().recovery).toBe("continue"));
    const continueStart = nextPortMessage(runtimePort!);
    expect(client.recoverTurn()).toBe(true);
    await expect(continueStart).resolves.toMatchObject({
      type: "toss.ai.host.start_turn",
      prompt: "Continue from the current state without repeating completed work."
    });
  });

  it("preserves a queued follow-up while recovering a failed turn", async () => {
    const client = new AiRuntimeClient("en");
    clients.push(client);
    let runtimePort: MessagePort | null = null;
    let sessionId = "";
    const { frame } = runtimeFrame((init, port) => {
      runtimePort = port;
      sessionId = init.sessionId;
      port.start();
      postRuntimeInitialized(port, init);
    });
    client.connect(frame);
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));

    const firstStart = nextPortMessage(runtimePort!);
    expect(client.startTurn("original request")).toBe(true);
    const firstTurn = await firstStart as { turnId: string };
    expect(client.submitPrompt("queued follow-up")).toBe(true);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.error",
      sessionId,
      turnId: firstTurn.turnId,
      code: "provider_request_failed",
      message: "Provider request failed."
    });
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      queuedPrompt: "queued follow-up",
      recovery: "retry"
    }));

    const retryStart = nextPortMessage(runtimePort!);
    expect(client.recoverTurn()).toBe(true);
    const retryTurn = await retryStart as { turnId: string; prompt: string };
    expect(retryTurn.prompt).toBe("original request");
    expect(client.getSnapshot()).toMatchObject({
      status: "running",
      queuedPrompt: "queued follow-up",
      recovery: null
    });

    const queuedStart = nextPortMessage(runtimePort!);
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId: retryTurn.turnId,
      blockId: "content-retry",
      kind: "text"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId: retryTurn.turnId,
      blockId: "content-retry",
      delta: "recovered"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.content_end",
      sessionId,
      turnId: retryTurn.turnId,
      blockId: "content-retry"
    });
    runtimePort!.postMessage({
      type: "toss.ai.runtime.turn_complete",
      sessionId,
      turnId: retryTurn.turnId,
      outcome: "completed"
    });
    await expect(queuedStart).resolves.toMatchObject({
      type: "toss.ai.host.start_turn",
      prompt: "queued follow-up"
    });
  });
});
