import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AiConversationStore,
  AiConversationWriteConflict,
  MAX_AI_CONVERSATIONS_PER_PROJECT,
  aiConversationTitleFromPrompt,
  conversationHistory,
  createAiConversation,
  storedMessagesToTranscript,
  transcriptToStoredMessages,
  type AiConversation,
  type AiConversationCollection,
  type AiConversationScope
} from "@/features/ai/conversationStore";
import type { AiTranscriptMessage } from "@/features/ai/runtimeClient";

export type AiConversationRepository = Pick<
  AiConversationStore,
  "load" | "save" | "setActive" | "delete"
>;

type ConversationState = AiConversationCollection & {
  ready: boolean;
  persistent: boolean;
  storageError: "conflict" | "unavailable" | null;
};

const browserConversationStore = typeof window !== "undefined" && window.indexedDB
  ? new AiConversationStore(window.indexedDB)
  : null;

function activeConversation(state: ConversationState) {
  return state.conversations.find((conversation) => (
    conversation.id === state.activeConversationId
  )) ?? null;
}

export function useAiConversations({
  accountId,
  projectId,
  defaultTitle,
  repository = browserConversationStore
}: {
  accountId: string | null;
  projectId: string;
  defaultTitle: string;
  repository?: AiConversationRepository | null;
}) {
  const scope = useMemo<AiConversationScope | null>(() => accountId && repository
    ? { accountId, projectId }
    : null, [accountId, projectId, repository]);
  const scopeRef = useRef(scope);
  const defaultTitleRef = useRef(defaultTitle);
  defaultTitleRef.current = defaultTitle;
  const [state, setReactState] = useState<ConversationState>({
    ready: false,
    persistent: !!scope && !!repository,
    storageError: null,
    conversations: [],
    activeConversationId: null
  });
  const stateRef = useRef(state);
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimers = useRef(new Map<string, number>());
  const persistedRevisions = useRef(
    new WeakMap<AiConversationScope, Map<string, number>>()
  );
  const transcriptVersions = useRef(new Map<string, string>());

  const commit = useCallback((next: ConversationState) => {
    stateRef.current = next;
    setReactState(next);
  }, []);

  const enqueue = useCallback((
    operation: () => Promise<unknown>,
    operationScope: AiConversationScope | null = scopeRef.current
  ) => {
    writeQueue.current = writeQueue.current.then(() => {
      const isCurrentScope = operationScope === scopeRef.current;
      if (isCurrentScope && !stateRef.current.persistent) return;
      return operation();
    }).catch((error: unknown) => {
      if (operationScope !== scopeRef.current) return;
      const current = stateRef.current;
      if (current.persistent) {
        commit({
          ...current,
          persistent: false,
          storageError: error instanceof AiConversationWriteConflict ? "conflict" : "unavailable"
        });
      }
    });
  }, [commit]);

  const revisionsForScope = useCallback((targetScope: AiConversationScope) => {
    let revisions = persistedRevisions.current.get(targetScope);
    if (!revisions) {
      revisions = new Map();
      persistedRevisions.current.set(targetScope, revisions);
    }
    return revisions;
  }, []);

  const persistConversation = useCallback(async (
    targetScope: AiConversationScope,
    conversation: AiConversation,
    activeConversationId: string | null
  ) => {
    if (!repository) return;
    const revisions = revisionsForScope(targetScope);
    const expectedRevision = revisions.get(conversation.id) ?? conversation.revision;
    const saved = await repository.save(
      targetScope,
      { ...conversation, revision: expectedRevision },
      activeConversationId
    );
    revisions.set(conversation.id, saved.revision);
    if (scopeRef.current !== targetScope) return;
    const current = stateRef.current;
    const local = current.conversations.find((item) => item.id === saved.id);
    if (!local || local.revision === saved.revision) return;
    commit({
      ...current,
      conversations: current.conversations.map((item) =>
        item.id === saved.id ? { ...item, revision: saved.revision } : item
      )
    });
  }, [commit, repository, revisionsForScope]);

  const flushConversation = useCallback((
    conversationId: string,
    targetScope: AiConversationScope | null = scopeRef.current
  ) => {
    const timer = saveTimers.current.get(conversationId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      saveTimers.current.delete(conversationId);
    }
    const current = stateRef.current;
    const conversation = current.conversations.find((item) => item.id === conversationId);
    if (!conversation || !targetScope || !repository || !current.persistent) return;
    enqueue(
      () => persistConversation(targetScope, conversation, current.activeConversationId),
      targetScope
    );
  }, [enqueue, persistConversation, repository]);

  const scheduleSave = useCallback((conversationId: string, immediate: boolean) => {
    if (!stateRef.current.persistent || !scopeRef.current || !repository) return;
    const current = saveTimers.current.get(conversationId);
    if (current !== undefined) window.clearTimeout(current);
    saveTimers.current.delete(conversationId);
    if (immediate) {
      flushConversation(conversationId);
      return;
    }
    saveTimers.current.set(conversationId, window.setTimeout(() => {
      saveTimers.current.delete(conversationId);
      flushConversation(conversationId);
    }, 350));
  }, [flushConversation, repository]);

  useLayoutEffect(() => {
    let cancelled = false;
    const timers = saveTimers.current;
    const cleanup = () => {
      cancelled = true;
      for (const conversationId of [...timers.keys()]) {
        flushConversation(conversationId, scope);
      }
    };
    scopeRef.current = scope;
    if (scope) persistedRevisions.current.set(scope, new Map());
    transcriptVersions.current.clear();
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
    const fallback = createAiConversation(defaultTitleRef.current);
    commit({
      ready: false,
      persistent: !!scope && !!repository,
      storageError: null,
      conversations: [],
      activeConversationId: null
    });
    if (!scope || !repository) {
      commit({
        ready: true,
        persistent: false,
        storageError: null,
        conversations: [fallback],
        activeConversationId: fallback.id
      });
      return cleanup;
    }
    const writesBeforeLoad = writeQueue.current;
    void writesBeforeLoad.then(() => repository.load(scope)).then((collection) => {
      if (cancelled) return;
      if (collection.conversations.length > 0) {
        const revisions = revisionsForScope(scope);
        for (const conversation of collection.conversations) {
          revisions.set(conversation.id, conversation.revision);
        }
        commit({ ...collection, ready: true, persistent: true, storageError: null });
        return;
      }
      const next = {
        conversations: [fallback],
        activeConversationId: fallback.id,
        ready: true,
        persistent: true,
        storageError: null
      } satisfies ConversationState;
      commit(next);
      enqueue(() => persistConversation(scope, fallback, fallback.id), scope);
    }).catch(() => {
      if (cancelled) return;
      commit({
        ready: true,
        persistent: false,
        storageError: "unavailable",
        conversations: [fallback],
        activeConversationId: fallback.id
      });
    });
    return cleanup;
  }, [
    commit,
    enqueue,
    flushConversation,
    persistConversation,
    repository,
    revisionsForScope,
    scope
  ]);

  useEffect(() => {
    const flushActive = () => {
      const activeId = stateRef.current.activeConversationId;
      if (activeId) flushConversation(activeId);
    };
    window.addEventListener("pagehide", flushActive);
    return () => window.removeEventListener("pagehide", flushActive);
  }, [flushConversation]);

  const select = useCallback((conversationId: string) => {
    const current = stateRef.current;
    if (!current.ready || current.activeConversationId === conversationId ||
      !current.conversations.some((item) => item.id === conversationId)) {
      return null;
    }
    if (current.activeConversationId) flushConversation(current.activeConversationId);
    const next = { ...current, activeConversationId: conversationId };
    commit(next);
    const currentScope = scopeRef.current;
    if (currentScope && repository && next.persistent) {
      enqueue(() => repository.setActive(currentScope, conversationId));
    }
    return next.conversations.find((item) => item.id === conversationId) ?? null;
  }, [commit, enqueue, flushConversation, repository]);

  const create = useCallback(() => {
    const current = stateRef.current;
    if (!current.ready) return null;
    if (current.activeConversationId) flushConversation(current.activeConversationId);
    const conversation = createAiConversation(defaultTitleRef.current);
    const conversations = [
      conversation,
      ...current.conversations
    ].slice(0, MAX_AI_CONVERSATIONS_PER_PROJECT);
    const next = {
      ...current,
      conversations,
      activeConversationId: conversation.id
    };
    commit(next);
    const currentScope = scopeRef.current;
    if (currentScope && repository && next.persistent) {
      enqueue(() => persistConversation(currentScope, conversation, conversation.id));
    }
    return conversation;
  }, [commit, enqueue, flushConversation, persistConversation, repository]);

  const rename = useCallback((conversationId: string, title: string) => {
    const normalizedTitle = title.trim().slice(0, 80);
    const current = stateRef.current;
    if (!normalizedTitle) return false;
    const conversation = current.conversations.find((item) => item.id === conversationId);
    if (!conversation) return false;
    const updated = {
      ...conversation,
      title: normalizedTitle,
      autoTitle: false,
      updatedAt: Date.now()
    };
    const next = {
      ...current,
      conversations: current.conversations.map((item) => item.id === conversationId ? updated : item)
    };
    commit(next);
    scheduleSave(conversationId, true);
    return true;
  }, [commit, scheduleSave]);

  const titleFromPrompt = useCallback((prompt: string) => {
    const current = stateRef.current;
    const conversation = activeConversation(current);
    if (!conversation?.autoTitle) return;
    const title = aiConversationTitleFromPrompt(prompt);
    if (!title) return;
    const updated = { ...conversation, title, autoTitle: false, updatedAt: Date.now() };
    const next = {
      ...current,
      conversations: current.conversations.map((item) => item.id === conversation.id ? updated : item)
    };
    commit(next);
    scheduleSave(conversation.id, false);
  }, [commit, scheduleSave]);

  const remove = useCallback((conversationId: string) => {
    const current = stateRef.current;
    const existing = current.conversations.find((item) => item.id === conversationId);
    if (!existing) return null;
    const timer = saveTimers.current.get(conversationId);
    if (timer !== undefined) window.clearTimeout(timer);
    saveTimers.current.delete(conversationId);
    transcriptVersions.current.delete(conversationId);
    let conversations = current.conversations.filter((item) => item.id !== conversationId);
    if (conversations.length === 0) conversations = [createAiConversation(defaultTitleRef.current)];
    const activeConversationId = current.activeConversationId === conversationId
      ? conversations[0].id
      : current.activeConversationId;
    const next = { ...current, conversations, activeConversationId };
    commit(next);
    const currentScope = scopeRef.current;
    if (currentScope && repository && next.persistent) {
      enqueue(async () => {
        const revisions = revisionsForScope(currentScope);
        const expectedRevision = revisions.get(conversationId) ?? existing.revision;
        await repository.delete(
          currentScope,
          conversationId,
          expectedRevision,
          activeConversationId
        );
        revisions.delete(conversationId);
        const replacement = conversations.find((item) => item.id === activeConversationId);
        if (replacement && current.conversations.length === 1) {
          await persistConversation(currentScope, replacement, replacement.id);
        }
      });
    }
    return conversations.find((item) => item.id === activeConversationId) ?? null;
  }, [commit, enqueue, persistConversation, repository, revisionsForScope]);

  const updateTranscript = useCallback((
    messages: readonly AiTranscriptMessage[],
    immediate = false,
    sourceVersion?: string
  ) => {
    const current = stateRef.current;
    const conversation = activeConversation(current);
    if (!conversation) return;
    if (sourceVersion && transcriptVersions.current.get(conversation.id) === sourceVersion) return;
    if (sourceVersion) transcriptVersions.current.set(conversation.id, sourceVersion);
    const storedMessages = transcriptToStoredMessages(messages);
    const updated = { ...conversation, messages: storedMessages, updatedAt: Date.now() };
    const next = {
      ...current,
      conversations: [
        updated,
        ...current.conversations.filter((item) => item.id !== conversation.id)
      ]
    };
    commit(next);
    scheduleSave(conversation.id, immediate);
  }, [commit, scheduleSave]);

  const current = activeConversation(state);
  return {
    ...state,
    activeConversation: current,
    activeTranscript: current ? storedMessagesToTranscript(current.messages) : [],
    activeHistory: current ? conversationHistory(current) : [],
    select,
    create,
    rename,
    remove,
    titleFromPrompt,
    updateTranscript
  };
}
