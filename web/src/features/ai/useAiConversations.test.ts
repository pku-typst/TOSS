// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AiConversation,
  AiConversationCollection,
  AiConversationScope
} from "@/features/ai/conversationStore";
import {
  useAiConversations,
  type AiConversationRepository
} from "@/features/ai/useAiConversations";
import type { AiTranscriptMessage } from "@/features/ai/runtimeClient";

function key(scope: AiConversationScope) {
  return `${scope.accountId}:${scope.projectId}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

class MemoryConversationRepository implements AiConversationRepository {
  readonly scopes = new Map<string, AiConversationCollection>();

  async load(scope: AiConversationScope) {
    return copy(this.scopes.get(key(scope)) ?? {
      conversations: [],
      activeConversationId: null
    });
  }

  async save(
    scope: AiConversationScope,
    conversation: AiConversation,
    activeConversationId: string | null
  ) {
    const current = this.scopes.get(key(scope)) ?? {
      conversations: [],
      activeConversationId: null
    };
    this.scopes.set(key(scope), copy({
      conversations: [
        conversation,
        ...current.conversations.filter((item) => item.id !== conversation.id)
      ],
      activeConversationId
    }));
  }

  async setActive(scope: AiConversationScope, activeConversationId: string | null) {
    const current = this.scopes.get(key(scope)) ?? {
      conversations: [],
      activeConversationId: null
    };
    this.scopes.set(key(scope), copy({ ...current, activeConversationId }));
  }

  async delete(
    scope: AiConversationScope,
    conversationId: string,
    nextActiveId: string | null
  ) {
    const current = this.scopes.get(key(scope)) ?? {
      conversations: [],
      activeConversationId: null
    };
    this.scopes.set(key(scope), copy({
      conversations: current.conversations.filter((item) => item.id !== conversationId),
      activeConversationId: nextActiveId
    }));
  }
}

function completedTranscript(): AiTranscriptMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [{
        id: "user-content-1",
        type: "text",
        text: "Project A question",
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
      parts: [{
        id: "assistant-content-1",
        type: "text",
        text: "Project A answer",
        state: "complete",
        startedAt: 2,
        completedAt: 2
      }],
      state: "complete",
      startedAt: 2,
      completedAt: 2
    }
  ];
}

describe("useAiConversations", () => {
  it("keeps independent persistent collections per account and project", async () => {
    const repository = new MemoryConversationRepository();
    const { result, rerender } = renderHook(
      ({ projectId }) => useAiConversations({
        accountId: "account-1",
        projectId,
        defaultTitle: "New conversation",
        repository
      }),
      { initialProps: { projectId: "project-a" } }
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    const firstConversationId = result.current.activeConversationId!;
    act(() => result.current.updateTranscript(completedTranscript(), true));
    await waitFor(() => expect(
      repository.scopes.get("account-1:project-a")?.conversations[0].messages
    ).toHaveLength(2));

    let secondConversationId = "";
    act(() => {
      secondConversationId = result.current.create()!.id;
    });
    expect(secondConversationId).not.toBe(firstConversationId);
    expect(result.current.conversations).toHaveLength(2);
    act(() => {
      result.current.select(firstConversationId);
    });
    await waitFor(() => expect(
      repository.scopes.get("account-1:project-a")?.activeConversationId
    ).toBe(firstConversationId));

    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.activeConversationId).not.toBe(firstConversationId);

    rerender({ projectId: "project-a" });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.conversations).toHaveLength(2);
    expect(result.current.activeConversationId).toBe(firstConversationId);
    expect(result.current.activeHistory).toEqual([
      { role: "user", content: "Project A question", timestamp: 1 },
      { role: "assistant", content: "Project A answer", timestamp: 2 }
    ]);
  });

  it("supports multiple guest conversations without claiming persistence", async () => {
    const { result } = renderHook(() => useAiConversations({
      accountId: null,
      projectId: "guest-project",
      defaultTitle: "New conversation",
      repository: null
    }));

    await waitFor(() => expect(result.current.ready).toBe(true));
    const firstConversationId = result.current.activeConversationId!;
    act(() => {
      result.current.create();
    });
    expect(result.current.persistent).toBe(false);
    expect(result.current.conversations).toHaveLength(2);
    act(() => {
      result.current.select(firstConversationId);
    });
    expect(result.current.activeConversationId).toBe(firstConversationId);
  });
});
