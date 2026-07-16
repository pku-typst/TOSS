import { describe, expect, it } from "vitest";
import {
  aiConversationTitleFromPrompt,
  conversationHistory,
  createAiConversation,
  normalizeAiConversation,
  storedMessagesToTranscript,
  transcriptToStoredMessages,
  type AiConversation
} from "@/features/ai/conversationStore";
import type { AiTranscriptMessage } from "@/features/ai/runtimeClient";

function transcript(): AiTranscriptMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [{
        id: "user-text-1",
        type: "text",
        text: "Inspect main.typ",
        state: "complete",
        startedAt: 1,
        completedAt: 1
      }],
      state: "complete",
      startedAt: 1,
      completedAt: 1
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          id: "reasoning-1",
          type: "reasoning",
          text: "private transient reasoning",
          state: "complete",
          startedAt: 2,
          completedAt: 3
        },
        {
          id: "tool-1",
          type: "tool",
          tool: "read_project_file",
          path: "main.typ",
          query: null,
          startLine: 1,
          endLine: 20,
          reviewId: null,
          state: "complete",
          outcome: "success",
          errorCode: null,
          startedAt: 3,
          completedAt: 4
        },
        {
          id: "assistant-text-1",
          type: "text",
          text: "The title is missing.",
          state: "complete",
          startedAt: 4,
          completedAt: 5
        }
      ],
      state: "complete",
      startedAt: 2,
      completedAt: 5
    }
  ];
}

function conversation(messages = transcriptToStoredMessages(transcript())): AiConversation {
  return {
    id: "conversation-1",
    revision: 0,
    title: "Inspect main.typ",
    autoTitle: false,
    createdAt: 1,
    updatedAt: 5,
    messages
  };
}

describe("AI conversation persistence projection", () => {
  it("persists visible text and tool summaries without reasoning content", () => {
    const stored = transcriptToStoredMessages(transcript());

    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({
      role: "assistant",
      text: "The title is missing.",
      tools: [{ tool: "read_project_file", path: "main.typ", state: "complete" }]
    });
    expect(JSON.stringify(stored)).not.toContain("private transient reasoning");
    expect(storedMessagesToTranscript(stored)[1]).toMatchObject({
      state: "complete",
      parts: [
        { type: "tool", tool: "read_project_file" },
        { type: "text", text: "The title is missing." }
      ]
    });
  });

  it("settles a partially streamed turn as interrupted on disk", () => {
    const current = transcript();
    current[1] = { ...current[1], state: "streaming", completedAt: null };

    expect(transcriptToStoredMessages(current, 10)[1]).toMatchObject({
      state: "interrupted",
      completedAt: 10
    });
  });

  it("restores only completed visible user/assistant pairs into model history", () => {
    const stored = transcriptToStoredMessages(transcript());
    const interrupted = {
      ...stored[0],
      id: "user-2",
      text: "unfinished question",
      state: "interrupted" as const
    };

    expect(conversationHistory(conversation([...stored, interrupted]))).toEqual([
      { role: "user", content: "Inspect main.typ", timestamp: 1 },
      { role: "assistant", content: "The title is missing.", timestamp: 2 }
    ]);
  });

  it("bounds each restored message as well as the total history", () => {
    const stored = transcriptToStoredMessages(transcript());
    const oversized = stored.map((message) => ({
      ...message,
      text: message.role === "user" ? "u".repeat(40_000) : "a".repeat(40_000)
    }));
    const history = conversationHistory(conversation(oversized), 24, 48_000, 20_000);

    expect(history).toHaveLength(2);
    expect(history[0].content).toHaveLength(20_000);
    expect(history[0].content).toMatch(/…$/);
    expect(history[1].content).toHaveLength(20_000);
    expect(history.reduce((sum, message) => sum + message.content.length, 0)).toBe(40_000);
  });

  it("generates a bounded title from the first prompt", () => {
    expect(aiConversationTitleFromPrompt("  Add   title\nmetadata  ")).toBe("Add title metadata");
    expect(aiConversationTitleFromPrompt("x".repeat(120))).toHaveLength(80);
    expect(aiConversationTitleFromPrompt("x".repeat(120))).toMatch(/…$/);
  });

  it("rejects malformed persisted records", () => {
    expect(normalizeAiConversation({ ...conversation(), title: "" })).toBeNull();
    expect(normalizeAiConversation({ ...conversation(), revision: -1 })).toBeNull();
    expect(normalizeAiConversation({
      ...conversation(),
      messages: [{ ...conversation().messages[0], state: "streaming" }]
    })).toBeNull();
  });

  it("creates distinct project-local conversation identities", () => {
    expect(createAiConversation("New conversation", 5)).toMatchObject({
      title: "New conversation",
      autoTitle: true,
      createdAt: 5,
      updatedAt: 5,
      messages: []
    });
    expect(createAiConversation("A").id).not.toBe(createAiConversation("B").id);
  });
});
