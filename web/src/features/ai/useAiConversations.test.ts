// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AiConversation,
  AiConversationCollection,
  AiConversationScope
} from "@/features/ai/conversationStore";
import {
  AiConversationWriteConflict,
  createAiConversation
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
    const existing = current.conversations.find((item) => item.id === conversation.id) ?? null;
    if (
      (existing && existing.revision !== conversation.revision) ||
      (!existing && conversation.revision !== 0)
    ) {
      throw new AiConversationWriteConflict(existing);
    }
    const saved = { ...conversation, revision: conversation.revision + 1 };
    this.scopes.set(key(scope), copy({
      conversations: [
        saved,
        ...current.conversations.filter((item) => item.id !== conversation.id)
      ],
      activeConversationId
    }));
    return copy(saved);
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
    expectedRevision: number,
    nextActiveId: string | null
  ) {
    const current = this.scopes.get(key(scope)) ?? {
      conversations: [],
      activeConversationId: null
    };
    const existing = current.conversations.find((item) => item.id === conversationId) ?? null;
    if (existing && existing.revision !== expectedRevision) {
      throw new AiConversationWriteConflict(existing);
    }
    this.scopes.set(key(scope), copy({
      conversations: current.conversations.filter((item) => item.id !== conversationId),
      activeConversationId: nextActiveId
    }));
  }
}

class DelayedSaveRepository extends MemoryConversationRepository {
  readonly saveStarted = deferred();
  readonly releaseSave = deferred();
  delayNextSave = false;

  override async save(
    scope: AiConversationScope,
    conversation: AiConversation,
    activeConversationId: string | null
  ) {
    if (this.delayNextSave) {
      this.delayNextSave = false;
      this.saveStarted.resolve();
      await this.releaseSave.promise;
    }
    return super.save(scope, conversation, activeConversationId);
  }
}

function completedTranscript(
  question = "Project A question",
  answer = "Project A answer"
): AiTranscriptMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [{
        id: "user-content-1",
        type: "text",
        text: question,
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
        text: answer,
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

  it("stops persistent writes instead of overwriting a newer tab revision", async () => {
    const repository = new MemoryConversationRepository();
    const scope = { accountId: "account-1", projectId: "project-a" };
    const conversation = createAiConversation("Shared conversation", 1);
    const otherConversation = createAiConversation("Other conversation", 2);
    repository.scopes.set(key(scope), {
      conversations: [conversation, otherConversation],
      activeConversationId: conversation.id
    });
    const first = renderHook(() => useAiConversations({
      ...scope,
      defaultTitle: "New conversation",
      repository
    }));
    const second = renderHook(() => useAiConversations({
      ...scope,
      defaultTitle: "New conversation",
      repository
    }));
    await waitFor(() => {
      expect(first.result.current.ready).toBe(true);
      expect(second.result.current.ready).toBe(true);
    });

    act(() => first.result.current.updateTranscript(
      completedTranscript("First tab", "First answer"),
      true,
      "first:1"
    ));
    await waitFor(() => expect(
      repository.scopes.get(key(scope))?.conversations[0].messages[0].text
    ).toBe("First tab"));
    act(() => {
      second.result.current.updateTranscript(
        completedTranscript("Second tab", "Second answer"),
        true,
        "second:1"
      );
      second.result.current.select(otherConversation.id);
    });

    await waitFor(() => expect(second.result.current).toMatchObject({
      persistent: false,
      storageError: "conflict"
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(repository.scopes.get(key(scope))?.conversations[0].messages[0].text).toBe("First tab");
    expect(repository.scopes.get(key(scope))?.activeConversationId).toBe(conversation.id);
  });

  it("does not delete a conversation updated by another tab", async () => {
    const repository = new MemoryConversationRepository();
    const scope = { accountId: "account-1", projectId: "project-a" };
    const conversation = createAiConversation("Shared conversation", 1);
    repository.scopes.set(key(scope), {
      conversations: [conversation],
      activeConversationId: conversation.id
    });
    const first = renderHook(() => useAiConversations({
      ...scope,
      defaultTitle: "New conversation",
      repository
    }));
    const second = renderHook(() => useAiConversations({
      ...scope,
      defaultTitle: "New conversation",
      repository
    }));
    await waitFor(() => {
      expect(first.result.current.ready).toBe(true);
      expect(second.result.current.ready).toBe(true);
    });

    act(() => first.result.current.updateTranscript(
      completedTranscript("Newer tab", "Newer answer"),
      true,
      "first:1"
    ));
    await waitFor(() => expect(
      repository.scopes.get(key(scope))?.conversations[0].revision
    ).toBe(1));
    act(() => {
      second.result.current.remove(conversation.id);
    });

    await waitFor(() => expect(second.result.current).toMatchObject({
      persistent: false,
      storageError: "conflict"
    }));
    expect(repository.scopes.get(key(scope))?.conversations[0]).toMatchObject({
      id: conversation.id,
      revision: 1
    });
  });

  it("deletes after its own queued save without reporting a false conflict", async () => {
    const repository = new MemoryConversationRepository();
    const scope = { accountId: "account-1", projectId: "project-a" };
    const conversation = createAiConversation("Conversation to remove", 1);
    repository.scopes.set(key(scope), {
      conversations: [conversation],
      activeConversationId: conversation.id
    });
    const { result } = renderHook(() => useAiConversations({
      ...scope,
      defaultTitle: "New conversation",
      repository
    }));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.updateTranscript(completedTranscript(), true, "turn:1");
      result.current.remove(conversation.id);
    });

    await waitFor(() => expect(
      repository.scopes.get(key(scope))?.conversations.some((item) => item.id === conversation.id)
    ).toBe(false));
    expect(result.current).toMatchObject({ persistent: true, storageError: null });
  });

  it("waits for outgoing writes before reloading the same logical scope", async () => {
    const repository = new DelayedSaveRepository();
    const conversationA = createAiConversation("Project A", 1);
    const conversationB = createAiConversation("Project B", 2);
    repository.scopes.set("account-1:project-a", {
      conversations: [conversationA],
      activeConversationId: conversationA.id
    });
    repository.scopes.set("account-1:project-b", {
      conversations: [conversationB],
      activeConversationId: conversationB.id
    });
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

    repository.delayNextSave = true;
    act(() => result.current.updateTranscript(
      completedTranscript("Latest A", "Latest answer"),
      true,
      "a:1"
    ));
    await repository.saveStarted.promise;
    rerender({ projectId: "project-b" });
    rerender({ projectId: "project-a" });

    expect(result.current.ready).toBe(false);
    repository.releaseSave.resolve();
    await waitFor(() => expect(result.current).toMatchObject({
      ready: true,
      persistent: true,
      storageError: null
    }));
    expect(result.current.activeHistory[0]?.content).toBe("Latest A");
  });
});
