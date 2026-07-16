import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AiAgentSession } from "@/ai-runtime/agentSession";
import { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";
import { createAiWorkspaceTools } from "@/ai-runtime/workspaceTools";
import type {
  AiHostToolResult,
  AiRuntimeTokenUsage,
  AiRuntimeToolCall
} from "@/features/ai/protocol";

describe("AiAgentSession", () => {
  it("uses the configured model limits and emits provider-reported token usage", async () => {
    let observedModel: {
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      requestedReasoning: string | undefined;
    } | null = null;
    const stream: StreamFn = (model, _context, options) => {
      observedModel = {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        requestedReasoning: options?.reasoning
      };
      const message = {
        ...fauxAssistantMessage("reported response"),
        usage: {
          input: 900,
          output: 100,
          cacheRead: 200,
          cacheWrite: 0,
          reasoning: 40,
          totalTokens: 1_200,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      };
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = { ...message, content: [] };
        events.push({ type: "start", partial });
        const withText = { ...message, content: [{ type: "text" as const, text: "reported response" }] };
        events.push({ type: "text_start", contentIndex: 0, partial: withText });
        events.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "reported response",
          partial: withText
        });
        events.push({
          type: "text_end",
          contentIndex: 0,
          content: "reported response",
          partial: withText
        });
        events.push({ type: "done", reason: "stop", message: withText });
        events.end(withText);
      });
      return events;
    };
    const usage: AiRuntimeTokenUsage[] = [];
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-usage",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-usage",
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        reasoning: false,
        requestOverrides: {}
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-usage",
      history: [],
      stream,
      systemPrompt: "test-system-prompt",
      onContent: () => undefined,
      onUsage: (_turnId, update) => usage.push(update)
    });

    await expect(session.prompt("turn-usage", "measure usage")).resolves.toEqual({
      outcome: "completed"
    });
    expect(observedModel).toEqual({
      contextWindow: 131_072,
      maxTokens: 8_192,
      reasoning: false,
      requestedReasoning: undefined
    });
    expect(usage.at(-1)).toMatchObject({
      contextSource: "provider",
      providerCalls: 1,
      reportedCalls: 1,
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      contextTokens: 1_200,
      inputTokens: 900,
      outputTokens: 100,
      reasoningTokens: 40,
      cacheReadTokens: 200,
      totalTokens: 1_200
    });
    session.dispose();
  });

  it("applies exact Provider JSON on every call without asking pi to synthesize reasoning fields", async () => {
    const faux = createFauxCore({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("provider json applied")]);
    let transformedPayload: Promise<unknown> = Promise.resolve(null);
    let requestedReasoning: string | undefined;
    let reasoningCapable = false;
    const stream: StreamFn = (model, context, options) => {
      reasoningCapable = model.reasoning;
      requestedReasoning = options?.reasoning;
      transformedPayload = Promise.resolve(options?.onPayload?.({
        model: model.id,
        messages: [],
        chat_template_kwargs: { preserve_thinking: true }
      }, model));
      return faux.streamSimple(model, context, { ...options, onPayload: undefined });
    };
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-provider-json",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "reasoning-model",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: {
          chat_template_kwargs: {
            enable_thinking: true,
            reasoning_budget: 8_192
          },
          nvext: { max_thinking_tokens: 4_096 }
        }
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-provider-json",
      history: [],
      stream,
      systemPrompt: "test-system-prompt",
      onContent: () => undefined
    });

    await expect(session.prompt("turn-provider-json", "test overrides")).resolves.toEqual({
      outcome: "completed"
    });
    await expect(transformedPayload).resolves.toEqual({
      model: "reasoning-model",
      messages: [],
      chat_template_kwargs: {
        preserve_thinking: true,
        enable_thinking: true,
        reasoning_budget: 8_192
      },
      nvext: { max_thinking_tokens: 4_096 }
    });
    expect(reasoningCapable).toBe(true);
    expect(requestedReasoning).toBeUndefined();
    session.dispose();
  });

  it("fails explicitly when the current request cannot fit after context transformation", async () => {
    const faux = createFauxCore({ tokensPerSecond: 100_000 });
    const usage: AiRuntimeTokenUsage[] = [];
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-small-context",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "small-context-model",
        contextWindow: 8_192,
        maxOutputTokens: 3_072,
        reasoning: false,
        requestOverrides: {}
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-small-context",
      history: [],
      stream: faux.streamSimple,
      systemPrompt: "test-system-prompt",
      onContent: () => undefined,
      onUsage: (_turnId, update) => usage.push(update)
    });

    await expect(session.prompt("turn-overflow", "x".repeat(10_000))).resolves.toEqual({
      outcome: "failed",
      code: "ai_agent_context_budget_exceeded"
    });
    expect(faux.state.callCount).toBe(0);
    expect(usage.at(-1)).toMatchObject({
      contextSource: "estimated",
      providerCalls: 0,
      reportedCalls: 0
    });
    session.dispose();
  });

  it("uses pi Agent for streamed, stateful multi-turn conversation", async () => {
    const faux = createFauxCore({ tokensPerSecond: 100_000 });
    let secondTurnRoles: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("inspect the request"),
        fauxText("first response")
      ]),
      (context) => {
        secondTurnRoles = context.messages.map((message) => message.role);
        return fauxAssistantMessage("second response");
      }
    ]);
    const blockKinds = new Map<string, "text" | "reasoning">();
    const deltas: Array<{ turnId: string; blockId: string; text: string }> = [];
    let requestedReasoning: string | undefined;
    let reasoningCapable = false;
    const stream: StreamFn = (model, context, options) => {
      reasoningCapable = model.reasoning;
      requestedReasoning = options?.reasoning;
      return faux.streamSimple(model, context, options);
    };
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-1",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: {
          reasoning: { effort: "high", summary: "auto" }
        }
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-1",
      history: [],
      stream,
      systemPrompt: "test-system-prompt",
      onContent: (turnId, event) => {
        if (event.type === "start") blockKinds.set(`${turnId}:${event.blockId}`, event.kind);
        if (event.type === "delta") {
          deltas.push({ turnId, blockId: event.blockId, text: event.delta });
        }
      }
    });

    await expect(session.prompt("turn-1", "first prompt")).resolves.toEqual({ outcome: "completed" });
    await expect(session.prompt("turn-2", "second prompt")).resolves.toEqual({ outcome: "completed" });

    expect(faux.state.callCount).toBe(2);
    expect(reasoningCapable).toBe(true);
    expect(requestedReasoning).toBeUndefined();
    expect(secondTurnRoles).toEqual(["user", "assistant", "user"]);
    expect(deltas.filter((item) => (
      item.turnId === "turn-1" && blockKinds.get(`${item.turnId}:${item.blockId}`) === "reasoning"
    )).map((item) => item.text).join(""))
      .toBe("inspect the request");
    expect(deltas.filter((item) => (
      item.turnId === "turn-1" && blockKinds.get(`${item.turnId}:${item.blockId}`) === "text"
    )).map((item) => item.text).join(""))
      .toBe("first response");
    expect(deltas.filter((item) => (
      item.turnId === "turn-2" && blockKinds.get(`${item.turnId}:${item.blockId}`) === "text"
    )).map((item) => item.text).join(""))
      .toBe("second response");
    session.dispose();
  });

  it("feeds a line-numbered Workspace tool result back into the next model call", async () => {
    const faux = createFauxCore({ tokensPerSecond: 100_000 });
    let secondCallRoles: string[] = [];
    let observedToolText = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_project_file", {
          path: "main.typ",
          start_line: 1,
          end_line: 20
        }, { id: "model-tool-1" }),
        { stopReason: "toolUse" }
      ),
      (context) => {
        secondCallRoles = context.messages.map((message) => message.role);
        const result = context.messages.find((message) => message.role === "toolResult");
        observedToolText = result?.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("") ?? "";
        return fauxAssistantMessage("The current title is Example.");
      }
    ]);
    const channel = new MessageChannel();
    const bridge = new AiRuntimeToolBridge(channel.port1, "session-1");
    channel.port1.addEventListener("message", (event) => {
      bridge.handleResult(event.data as AiHostToolResult);
    });
    const hostRequest = new Promise<AiRuntimeToolCall>((resolve) => {
      channel.port2.addEventListener("message", (event) => {
        const message = event.data as AiRuntimeToolCall;
        if (message.type !== "toss.ai.runtime.tool_call") return;
        resolve(message);
        channel.port2.postMessage({
          type: "toss.ai.host.tool_result",
          sessionId: message.sessionId,
          turnId: message.turnId,
          callId: message.callId,
          tool: message.tool,
          response: {
            outcome: "success",
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
          }
        });
      });
      channel.port2.start();
    });
    channel.port1.start();
    const tools = createAiWorkspaceTools({
      project_type: "typst",
      mode: "live",
      tools: ["read_project_file"]
    }, bridge);
    const textBlocks = new Set<string>();
    const deltas: string[] = [];
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-tools",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: false,
        requestOverrides: {}
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-tools",
      history: [],
      stream: faux.streamSimple,
      systemPrompt: "Use the Workspace tools.",
      tools,
      onContent: (_turnId, event) => {
        if (event.type === "start" && event.kind === "text") textBlocks.add(event.blockId);
        if (event.type === "delta" && textBlocks.has(event.blockId)) deltas.push(event.delta);
      }
    });

    bridge.beginTurn("turn-tools");
    await expect(session.prompt("turn-tools", "What is the title?")).resolves.toEqual({
      outcome: "completed"
    });
    bridge.endTurn("turn-tools");
    await expect(hostRequest).resolves.toMatchObject({
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 20 }
    });
    expect(faux.state.callCount).toBe(2);
    expect(secondCallRoles).toEqual(["user", "assistant", "toolResult"]);
    expect(observedToolText).toContain("1 | #set document(title: [Example])");
    expect(deltas.join("")).toBe("The current title is Example.");

    session.dispose();
    bridge.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  it("replaces model context and provider session when the conversation changes", async () => {
    const faux = createFauxCore({ tokensPerSecond: 100_000 });
    const observedMessages: Array<Array<{ role: string; text: string }>> = [];
    const observedSessionIds: Array<string | undefined> = [];
    const messageText = (message: { content?: unknown }) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content.map((part) => (
        typeof part === "object" && part !== null &&
        "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
          ? part.text
          : ""
      )).join("");
    };
    faux.setResponses([
      (context, options) => {
        observedSessionIds.push(options?.sessionId);
        observedMessages.push(context.messages.map((message) => ({
          role: message.role,
          text: messageText(message)
        })));
        return fauxAssistantMessage("first response");
      },
      (context, options) => {
        observedSessionIds.push(options?.sessionId);
        observedMessages.push(context.messages.map((message) => ({
          role: message.role,
          text: messageText(message)
        })));
        return fauxAssistantMessage("second response");
      }
    ]);
    const session = new AiAgentSession({
      connection: {
        kind: "endpoint",
        connectionId: "connection-switch",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: false,
        requestOverrides: {}
      },
      credential: "credential-in-runtime-memory",
      conversationId: "conversation-1",
      history: [
        { role: "user", content: "old question", timestamp: 1 },
        { role: "assistant", content: "old answer", timestamp: 2 }
      ],
      stream: faux.streamSimple,
      systemPrompt: "test-system-prompt",
      onContent: () => undefined
    });

    await expect(session.prompt("turn-1", "continue old")).resolves.toEqual({ outcome: "completed" });
    session.setConversation("conversation-2", [
      { role: "user", content: "new history question", timestamp: 3 },
      { role: "assistant", content: "new history answer", timestamp: 4 }
    ]);
    await expect(session.prompt("turn-2", "continue new")).resolves.toEqual({ outcome: "completed" });

    expect(observedMessages[0]).toEqual([
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer" },
      { role: "user", text: "continue old" }
    ]);
    expect(observedMessages[1]).toEqual([
      { role: "user", text: "new history question" },
      { role: "assistant", text: "new history answer" },
      { role: "user", text: "continue new" }
    ]);
    expect(observedSessionIds).toEqual([
      "connection-switch:conversation-1",
      "connection-switch:conversation-2"
    ]);
    session.dispose();
  });
});
