import {
  fauxAssistantMessage,
  fauxToolCall,
  type ToolResultMessage,
  type UserMessage
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { transformAgentContext } from "@/ai-runtime/contextManager";

const user = (content: string, timestamp: number): UserMessage => ({
  role: "user",
  content,
  timestamp
});

const toolResult = (
  id: string,
  name: string,
  content: string,
  timestamp: number
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: content }],
  isError: false,
  timestamp
});

const options = {
  systemPrompt: "",
  tools: [],
  contextWindow: 8_192,
  maxOutputTokens: 256,
  safetyTokens: 4_096
} as const;

describe("AI Runtime context management", () => {
  it("keeps the canonical context unchanged while it fits", () => {
    const messages = [
      user("question", 1),
      fauxAssistantMessage("answer", { timestamp: 2 }),
      user("follow-up", 3)
    ];
    const result = transformAgentContext({ ...options, messages });

    expect(result).toMatchObject({ overflow: false, compactedMessages: 0 });
    expect(result.messages).toEqual(messages);
  });

  it("drops only complete older turns before the current user request", () => {
    const messages = [
      user("x".repeat(12_000), 1),
      fauxAssistantMessage("y".repeat(12_000), { timestamp: 2 }),
      user("current request", 3)
    ];
    const result = transformAgentContext({ ...options, messages });

    expect(result).toMatchObject({ overflow: false, compactedMessages: 2 });
    expect(result.messages).toEqual([messages[2]]);
  });

  it("compacts older tool payloads but preserves the latest tool batch", () => {
    const oldCallId = "old-patch";
    const latestCallId = "latest-read";
    const latestResult = JSON.stringify({ numbered_content: "1 | current source" });
    const messages = [
      user("fix the document", 1),
      fauxAssistantMessage(fauxToolCall("apply_patch", {
        path: "main.typ",
        base_snapshot: "snapshot-1",
        patch: "x".repeat(9_000)
      }, { id: oldCallId }), { stopReason: "toolUse", timestamp: 2 }),
      toolResult(oldCallId, "apply_patch", "y".repeat(9_000), 3),
      fauxAssistantMessage(fauxToolCall("read_project_file", {
        path: "main.typ",
        start_line: 1,
        end_line: 20
      }, { id: latestCallId }), { stopReason: "toolUse", timestamp: 4 }),
      toolResult(latestCallId, "read_project_file", latestResult, 5)
    ];
    const result = transformAgentContext({ ...options, messages });

    expect(result.overflow).toBe(false);
    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    const compactedCall = result.messages[1];
    expect(compactedCall.role).toBe("assistant");
    if (compactedCall.role === "assistant") {
      expect(compactedCall.content).toEqual([
        expect.objectContaining({
          type: "toolCall",
          arguments: expect.objectContaining({
            patch: expect.stringContaining("omitted from older tool history")
          })
        })
      ]);
    }
  });

  it("reports overflow instead of truncating the current user request", () => {
    const current = user("z".repeat(20_000), 1);
    const result = transformAgentContext({ ...options, messages: [current] });

    expect(result.overflow).toBe(true);
    expect(result.messages).toEqual([current]);
  });
});
