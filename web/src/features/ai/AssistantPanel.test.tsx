import { describe, expect, it } from "vitest";
import {
  activeTurnActivity,
  filterManagedModelProfiles,
  shouldShowManagedModelSearch,
  type AiTurnActivity
} from "@/features/ai/AssistantPanel";
import type {
  AiTranscriptMessage,
  AiTranscriptPart
} from "@/features/ai/runtimeClient";

function assistantMessage(
  parts: readonly AiTranscriptPart[],
  state: AiTranscriptMessage["state"] = "streaming"
): AiTranscriptMessage {
  return {
    id: "turn-1",
    role: "assistant",
    parts,
    state,
    startedAt: 1,
    completedAt: state === "streaming" ? null : 2
  };
}

function contentPart(type: "text" | "reasoning", state: "streaming" | "complete") {
  return {
    id: `${type}-1`,
    type,
    text: state === "streaming" ? "partial" : "done",
    state,
    startedAt: 1,
    completedAt: state === "complete" ? 2 : null
  } as const;
}

function toolPart(state: "running" | "complete") {
  return {
    id: "tool-1",
    type: "tool",
    tool: "read_project_file",
    path: "main.typ",
    query: null,
    startLine: null,
    endLine: null,
    reviewId: null,
    state,
    outcome: state === "complete" ? "success" : null,
    errorCode: null,
    startedAt: 1,
    completedAt: state === "complete" ? 2 : null
  } as const;
}

describe("activeTurnActivity", () => {
  it.each<{
    name: string;
    parts: readonly AiTranscriptPart[];
    expected: AiTurnActivity;
  }>([
    { name: "before the first provider event", parts: [], expected: "thinking" },
    {
      name: "while reasoning is streamed",
      parts: [contentPart("reasoning", "streaming")],
      expected: "thinking"
    },
    { name: "while a Workspace tool runs", parts: [toolPart("running")], expected: "using-tools" },
    {
      name: "between a tool result and the next provider event",
      parts: [toolPart("complete")],
      expected: "analyzing-tool-results"
    },
    {
      name: "while answer text is streamed",
      parts: [contentPart("text", "streaming")],
      expected: "responding"
    }
  ])("projects activity $name", ({ parts, expected }) => {
    expect(activeTurnActivity(assistantMessage(parts))).toBe(expected);
  });

  it("stops projecting activity after the turn settles", () => {
    expect(activeTurnActivity(assistantMessage([toolPart("complete")], "complete"))).toBeNull();
  });
});

describe("managed model search", () => {
  const profiles = [
    {
      id: "opus",
      model: "us/vendor/claude-opus",
      label: { en: "Opus", "zh-CN": "Opus" }
    },
    {
      id: "qwen",
      model: "example/qwen-model",
      label: {
        en: "Qwen",
        "zh-CN": String.fromCodePoint(0x901a, 0x4e49, 0x63a8, 0x7406)
      }
    }
  ];

  it("matches localized labels and upstream model IDs", () => {
    expect(filterManagedModelProfiles(profiles, "QWEN", "en").map((item) => item.id)).toEqual([
      "qwen"
    ]);
    const localizedQuery = String.fromCodePoint(0x63a8, 0x7406);
    expect(filterManagedModelProfiles(profiles, localizedQuery, "zh-CN").map((item) => item.id)).toEqual([
      "qwen"
    ]);
    expect(filterManagedModelProfiles(profiles, "  ", "en")).toBe(profiles);
  });

  it("shows search only when the live approved list exceeds the compact selector limit", () => {
    expect(shouldShowManagedModelSearch(8)).toBe(false);
    expect(shouldShowManagedModelSearch(9)).toBe(true);
  });
});
