import { describe, expect, it } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiHostToRuntimeMessage,
  isAiRuntimeBootstrapInit,
  isAiRuntimeToHostMessage
} from "@/features/ai/protocol";
import { DEFAULT_RUNTIME_DESIGN_THEME } from "@/design/runtimeTheme";

describe("AI Runtime protocol validation", () => {
  const workspaceContext = {
    schema: 1,
    project_name: "Example",
    project_type: "typst",
    mode: "live",
    entry_file_path: "main.typ",
    active_path: "main.typ",
    access: "edit",
    workspace_state: "ready",
    active_document_state: "ready",
    files: { total: 2, text: 1, assets: 1 },
    compilation: { state: "succeeded", errors: 0, warnings: 0 },
    pending_edit_review: false
  } as const;
  const bootstrap = {
    type: "toss.ai.runtime.initialize",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: "session-1",
    nonce: "nonce-1",
    parentOrigin: "https://toss.example.test",
    locale: "en",
    theme: DEFAULT_RUNTIME_DESIGN_THEME,
    preferences: {
      providerRequestTimeoutMs: 120_000,
      maxProviderCallsPerTurn: 12,
      maxTurnMs: 300_000,
      catalogRequestTimeoutMs: 20_000
    },
    connection: { kind: "fake" },
    conversation: {
      conversationId: "conversation-1",
      history: []
    },
    workspace: {
      project_type: "typst",
      mode: "live",
      tools: [
        "list_project_files",
        "read_project_file",
        "search_project_text",
        "apply_patch",
        "write_file"
      ]
    }
  } as const;

  it("requires the exact protocol and build identifier", () => {
    expect(isAiRuntimeBootstrapInit(bootstrap)).toBe(true);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, protocolVersion: 2 })).toBe(false);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, buildId: "stale-build" })).toBe(false);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, locale: "fr" })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      theme: { ...bootstrap.theme, brand: "red; display: none" }
    })).toBe(false);
  });

  it("validates the bootstrap acknowledgement separately from readiness", () => {
    expect(isAiRuntimeToHostMessage({
      type: "toss.ai.runtime.bootstrap_ack",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId: "session-1",
      nonce: "nonce-1"
    })).toBe(true);
    expect(isAiRuntimeToHostMessage({
      type: "toss.ai.runtime.bootstrap_ack",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId: "session-1"
    })).toBe(false);
  });

  it("rejects unknown fields and generic network messages", () => {
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, credential: "secret" })).toBe(false);
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.fetch",
        sessionId: "session-1",
        url: "https://example.test"
      })
    ).toBe(false);
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.set_locale",
        sessionId: "session-1",
        locale: "zh-CN"
      })
    ).toBe(true);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.set_preferences",
      sessionId: "session-1",
      preferences: {
        providerRequestTimeoutMs: 90_000,
        maxProviderCallsPerTurn: 8,
        maxTurnMs: 240_000,
        catalogRequestTimeoutMs: 15_000
      }
    })).toBe(true);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.set_preferences",
      sessionId: "session-1",
      preferences: {
        providerRequestTimeoutMs: 90_000,
        maxProviderCallsPerTurn: 100,
        maxTurnMs: 240_000,
        catalogRequestTimeoutMs: 15_000
      }
    })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
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
          chat_template_kwargs: { enable_thinking: true, reasoning_budget: 8_192 }
        }
      }
    })).toBe(true);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      connection: {
        kind: "endpoint",
        connectionId: "connection-1",
        protocol: "unknown-protocol",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: false,
        requestOverrides: {}
      }
    })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      connection: {
        kind: "endpoint",
        connectionId: "connection-1",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: { messages: [] }
      }
    })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      connection: {
        kind: "endpoint",
        connectionId: "connection-1",
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 8_192,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: {}
      }
    })).toBe(false);
  });

  it("bounds prompts, deltas, and errors", () => {
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.connection_state",
        sessionId: "session-1",
        state: "credential_required"
      })
    ).toBe(true);
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.start_turn",
        sessionId: "session-1",
        conversationId: "conversation-1",
        turnId: "turn-1",
        prompt: "hello",
        workspace: workspaceContext
      })
    ).toBe(true);
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.content_start",
        sessionId: "session-1",
        turnId: "turn-1",
        blockId: "content-0-0",
        kind: "reasoning"
      })
    ).toBe(true);
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.content_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        blockId: "content-0-0",
        delta: "x".repeat(4_097)
      })
    ).toBe(false);
    const usage = {
      type: "toss.ai.runtime.usage",
      sessionId: "session-1",
      turnId: "turn-1",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      contextTokens: 18_000,
      contextSource: "provider",
      providerCalls: 2,
      reportedCalls: 2,
      inputTokens: 20_000,
      outputTokens: 1_000,
      reasoningTokens: 200,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
      totalTokens: 26_000,
      compactedMessages: 1
    } as const;
    expect(isAiRuntimeToHostMessage(usage)).toBe(true);
    expect(isAiRuntimeToHostMessage({ ...usage, reportedCalls: 3 })).toBe(false);
    expect(isAiRuntimeToHostMessage({ ...usage, reasoningTokens: 1_001 })).toBe(false);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.start_turn",
      sessionId: "session-1",
      conversationId: "conversation-1",
      turnId: "turn-1",
      prompt: "hello",
      workspace: { ...workspaceContext, files: { total: 1, text: 1, assets: 1 } }
    })).toBe(false);
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.error",
        sessionId: "session-1",
        code: "failed",
        message: "x".repeat(1_025)
      })
    ).toBe(false);
  });

  it("strictly validates bounded alternating conversation history", () => {
    const history = [
      { role: "user", content: "first question", timestamp: 1 },
      { role: "assistant", content: "first answer", timestamp: 2 }
    ] as const;
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      conversation: { conversationId: "conversation-1", history }
    })).toBe(true);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.set_conversation",
      sessionId: "session-1",
      conversation: { conversationId: "conversation-2", history }
    })).toBe(true);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      conversation: {
        conversationId: "conversation-1",
        history: [{ role: "assistant", content: "out of order", timestamp: 1 }]
      }
    })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      conversation: {
        conversationId: "conversation-1",
        history: [{ role: "user", content: "unpaired", timestamp: 1 }]
      }
    })).toBe(false);
    expect(isAiRuntimeBootstrapInit({
      ...bootstrap,
      conversation: {
        conversationId: "conversation-1",
        history: [{ role: "user", content: "x".repeat(32_769), timestamp: 1 }]
      }
    })).toBe(false);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.set_conversation",
      sessionId: "session-1",
      conversation: { conversationId: "conversation-2", history, credential: "secret" }
    })).toBe(false);
  });

  it("validates correlated workspace tool calls and results", () => {
    const call = {
      type: "toss.ai.runtime.tool_call",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 20 }
    } as const;
    expect(isAiRuntimeToHostMessage(call)).toBe(true);
    expect(isAiRuntimeToHostMessage({
      ...call,
      arguments: { query: "title" }
    })).toBe(false);

    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.tool_result",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "read_project_file",
      response: {
        outcome: "success",
        result: {
          path: "main.typ",
          snapshot_id: "sha256-example",
          start_line: 1,
          end_line: 2,
          total_lines: 2,
          has_more: false,
          content_truncated: false,
          numbered_content: "1 | #set document(title: [Example])\n2 | Hello"
        }
      }
    })).toBe(true);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.tool_result",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "read_project_file",
      response: {
        outcome: "success",
        result: {
          query: "title",
          case_sensitive: false,
          files_searched: 1,
          matches: [],
          truncated: false
        }
      }
    })).toBe(false);

    const patchCall = {
      type: "toss.ai.runtime.tool_call",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-2",
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: "sha256-example",
        patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1,2 +1,2 @@\n context\n-old\n+new"
      }
    } as const;
    expect(isAiRuntimeToHostMessage(patchCall)).toBe(true);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.tool_result",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-2",
      tool: "apply_patch",
      response: {
        outcome: "success",
        result: {
          path: "main.typ",
          base_snapshot: "sha256-example",
          status: "accepted",
          snapshot_id: "sha256-updated",
          verification: {
            status: "passed",
            errors: [],
            diagnostics: [{
              severity: "warning",
              message: "Example warning",
              path: "main.typ",
              line: 1,
              column: 1
            }],
            truncated: false
          }
        }
      }
    })).toBe(true);

    const writeCall = {
      type: "toss.ai.runtime.tool_call",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-3",
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: "sha256-example",
        content: "#set document(title: [Example])\nHello"
      }
    } as const;
    expect(isAiRuntimeToHostMessage(writeCall)).toBe(true);
    expect(isAiRuntimeToHostMessage({
      ...writeCall,
      arguments: { ...writeCall.arguments, content: "" }
    })).toBe(true);
    expect(isAiRuntimeToHostMessage({
      ...writeCall,
      arguments: { ...writeCall.arguments, extra: true }
    })).toBe(false);
    expect(isAiHostToRuntimeMessage({
      type: "toss.ai.host.tool_result",
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-3",
      tool: "write_file",
      response: {
        outcome: "success",
        result: {
          path: "main.typ",
          base_snapshot: "sha256-example",
          status: "rejected",
          snapshot_id: null,
          verification: {
            status: "passed",
            errors: [],
            diagnostics: [],
            truncated: false
          }
        }
      }
    })).toBe(true);
  });
});
