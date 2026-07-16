import {
  AI_RUNTIME_CONVERSATION_HISTORY_LIMITS,
  type AiRuntimeConversationHistoryMessage
} from "@/features/ai/protocol";
import type {
  AiTranscriptContentPart,
  AiTranscriptMessage,
  AiTranscriptToolOutcome,
  AiTranscriptToolPart
} from "@/features/ai/runtimeClient";
import {
  AI_WORKSPACE_TOOL_ERROR_CODES,
  AI_WORKSPACE_TOOL_NAMES,
  type AiWorkspaceToolErrorCode,
  type AiWorkspaceToolName
} from "@/features/ai/toolContract";

export const AI_CONVERSATION_STORE_SCHEMA = 1 as const;
export const MAX_AI_CONVERSATIONS_PER_PROJECT = 50;

const DATABASE_NAME = "toss-ai-conversations";
const DATABASE_VERSION = 1;
const CONVERSATIONS_STORE = "conversations";
const SCOPES_STORE = "scopes";
const SCOPE_INDEX = "by_scope";
const MAX_CONVERSATION_MESSAGES = 200;
const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 80;
const MAX_MESSAGE_TEXT_LENGTH = 131_072;
const MAX_ID_LENGTH = 128;

export type AiConversationScope = {
  accountId: string;
  projectId: string;
};

export type AiStoredConversationMessageState =
  | "complete"
  | "cancelled"
  | "error"
  | "interrupted";

export type AiStoredConversationTool = {
  id: string;
  tool: AiWorkspaceToolName;
  path: string | null;
  query: string | null;
  startLine: number | null;
  endLine: number | null;
  state: "complete" | "error" | "cancelled";
  outcome: AiTranscriptToolOutcome | null;
  errorCode: AiWorkspaceToolErrorCode | null;
  startedAt: number;
  completedAt: number;
};

export type AiStoredConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: readonly AiStoredConversationTool[];
  state: AiStoredConversationMessageState;
  startedAt: number;
  completedAt: number;
};

export type AiConversation = {
  id: string;
  title: string;
  autoTitle: boolean;
  createdAt: number;
  updatedAt: number;
  messages: readonly AiStoredConversationMessage[];
};

export type AiConversationCollection = {
  conversations: readonly AiConversation[];
  activeConversationId: string | null;
};

type StoredConversationRecord = AiConversation & {
  schema: typeof AI_CONVERSATION_STORE_SCHEMA;
  key: string;
  scopeKey: string;
};

type StoredScopeRecord = {
  schema: typeof AI_CONVERSATION_STORE_SCHEMA;
  scopeKey: string;
  activeConversationId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMessageState(value: unknown): value is AiStoredConversationMessageState {
  return value === "complete" || value === "cancelled" || value === "error" || value === "interrupted";
}

function isToolState(value: unknown): value is AiStoredConversationTool["state"] {
  return value === "complete" || value === "error" || value === "cancelled";
}

function isToolOutcome(value: unknown): value is AiTranscriptToolOutcome | null {
  return value === null || value === "success" || value === "accepted" || value === "rejected" ||
    value === "stale" || value === "compile_failed";
}

const workspaceToolNames = new Set<AiWorkspaceToolName>(AI_WORKSPACE_TOOL_NAMES);
const workspaceToolErrorCodes = new Set<AiWorkspaceToolErrorCode>(AI_WORKSPACE_TOOL_ERROR_CODES);

function normalizeStoredTool(value: unknown): AiStoredConversationTool | null {
  if (!isRecord(value)) return null;
  if (
    !boundedString(value.id, MAX_ID_LENGTH) ||
    typeof value.tool !== "string" ||
    !workspaceToolNames.has(value.tool as AiWorkspaceToolName) ||
    !(value.path === null || boundedString(value.path, 2_048)) ||
    !(value.query === null || boundedString(value.query, 256, true)) ||
    !(value.startLine === null || (Number.isInteger(value.startLine) && Number(value.startLine) > 0)) ||
    !(value.endLine === null || (Number.isInteger(value.endLine) && Number(value.endLine) > 0)) ||
    !isToolState(value.state) ||
    !isToolOutcome(value.outcome) ||
    !(
      value.errorCode === null ||
      (typeof value.errorCode === "string" &&
        workspaceToolErrorCodes.has(value.errorCode as AiWorkspaceToolErrorCode))
    ) ||
    !finiteTimestamp(value.startedAt) ||
    !finiteTimestamp(value.completedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    tool: value.tool as AiWorkspaceToolName,
    path: value.path as string | null,
    query: value.query as string | null,
    startLine: value.startLine as number | null,
    endLine: value.endLine as number | null,
    state: value.state,
    outcome: value.outcome,
    errorCode: value.errorCode as AiWorkspaceToolErrorCode | null,
    startedAt: value.startedAt,
    completedAt: value.completedAt
  };
}

function normalizeStoredMessage(value: unknown): AiStoredConversationMessage | null {
  if (
    !isRecord(value) ||
    !boundedString(value.id, MAX_ID_LENGTH) ||
    (value.role !== "user" && value.role !== "assistant") ||
    !boundedString(value.text, MAX_MESSAGE_TEXT_LENGTH, true) ||
    !Array.isArray(value.tools) ||
    value.tools.length > 64 ||
    !isMessageState(value.state) ||
    !finiteTimestamp(value.startedAt) ||
    !finiteTimestamp(value.completedAt)
  ) {
    return null;
  }
  const tools = value.tools.map(normalizeStoredTool);
  if (tools.some((tool) => tool === null)) return null;
  if (value.role === "user" && tools.length > 0) return null;
  return {
    id: value.id,
    role: value.role,
    text: value.text,
    tools: tools as AiStoredConversationTool[],
    state: value.state,
    startedAt: value.startedAt,
    completedAt: value.completedAt
  };
}

export function normalizeAiConversation(value: unknown): AiConversation | null {
  if (
    !isRecord(value) ||
    !boundedString(value.id, MAX_ID_LENGTH) ||
    !boundedString(value.title, MAX_TITLE_LENGTH) ||
    !value.title.trim() ||
    typeof value.autoTitle !== "boolean" ||
    !finiteTimestamp(value.createdAt) ||
    !finiteTimestamp(value.updatedAt) ||
    !Array.isArray(value.messages) ||
    value.messages.length > MAX_CONVERSATION_MESSAGES
  ) {
    return null;
  }
  const messages = value.messages.map(normalizeStoredMessage);
  if (messages.some((message) => message === null)) return null;
  return {
    id: value.id,
    title: value.title,
    autoTitle: value.autoTitle,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages: messages as AiStoredConversationMessage[]
  };
}

export function createAiConversation(title: string, now = Date.now()): AiConversation {
  const normalizedTitle = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!normalizedTitle) throw new Error("ai_conversation_title_required");
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const id = `conversation-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return {
    id,
    title: normalizedTitle,
    autoTitle: true,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

export function aiConversationTitleFromPrompt(prompt: string) {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function storedTool(part: AiTranscriptToolPart, completedAt: number): AiStoredConversationTool {
  const state = part.state === "running" ? "cancelled" : part.state;
  return {
    id: part.id,
    tool: part.tool,
    path: part.path,
    query: part.query,
    startLine: part.startLine,
    endLine: part.endLine,
    state,
    outcome: part.outcome,
    errorCode: part.errorCode,
    startedAt: part.startedAt,
    completedAt: part.completedAt ?? completedAt
  };
}

export function transcriptToStoredMessages(
  messages: readonly AiTranscriptMessage[],
  now = Date.now()
): AiStoredConversationMessage[] {
  return messages.slice(-MAX_CONVERSATION_MESSAGES).flatMap((message) => {
    const text = message.parts
      .filter((part): part is AiTranscriptContentPart & { type: "text" } => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .slice(0, MAX_MESSAGE_TEXT_LENGTH);
    const tools = message.role === "assistant"
      ? message.parts
          .filter((part): part is AiTranscriptToolPart => part.type === "tool")
          .map((part) => storedTool(part, now))
      : [];
    if (message.role === "user" && !text) return [];
    return [{
      id: message.id,
      role: message.role,
      text,
      tools,
      state: message.state === "streaming" ? "interrupted" : message.state,
      startedAt: message.startedAt,
      completedAt: message.completedAt ?? now
    }];
  });
}

export function storedMessagesToTranscript(
  messages: readonly AiStoredConversationMessage[]
): AiTranscriptMessage[] {
  return messages.map((message) => {
    const textPart = message.text ? [{
      id: `${message.id}-restored-text`,
      type: "text" as const,
      text: message.text,
      state: "complete" as const,
      startedAt: message.startedAt,
      completedAt: message.completedAt
    }] : [];
    const tools = message.tools.map((tool): AiTranscriptToolPart => ({
      ...tool,
      type: "tool"
    }));
    return {
      id: message.id,
      role: message.role,
      parts: [...tools, ...textPart],
      state: message.state,
      startedAt: message.startedAt,
      completedAt: message.completedAt
    };
  });
}

export function conversationHistory(
  conversation: AiConversation,
  maxMessages: number = AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxMessages,
  maxCharacters: number = AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxTotalLength,
  maxMessageCharacters: number = AI_RUNTIME_CONVERSATION_HISTORY_LIMITS.maxContentLength
): AiRuntimeConversationHistoryMessage[] {
  const pairs: AiRuntimeConversationHistoryMessage[][] = [];
  const contentLimit = Math.max(1, maxMessageCharacters);
  let pendingUser: AiStoredConversationMessage | null = null;
  for (const message of conversation.messages) {
    if (message.role === "user") {
      pendingUser = message.state === "complete" ? message : null;
      continue;
    }
    if (!pendingUser || message.state !== "complete" || !message.text) {
      pendingUser = null;
      continue;
    }
    const boundedContent = (content: string) => content.length <= contentLimit
      ? content
      : `${content.slice(0, contentLimit - 1).trimEnd()}…`;
    pairs.push([
      {
        role: "user",
        content: boundedContent(pendingUser.text),
        timestamp: pendingUser.startedAt
      },
      {
        role: "assistant",
        content: boundedContent(message.text),
        timestamp: message.startedAt
      }
    ]);
    pendingUser = null;
  }
  const selected: AiRuntimeConversationHistoryMessage[] = [];
  let characters = 0;
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index];
    const pairCharacters = pair[0].content.length + pair[1].content.length;
    if (selected.length + 2 > maxMessages || characters + pairCharacters > maxCharacters) break;
    selected.unshift(...pair);
    characters += pairCharacters;
  }
  return selected;
}

function scopeKey(scope: AiConversationScope) {
  return JSON.stringify([scope.accountId, scope.projectId]);
}

function conversationKey(scope: AiConversationScope, conversationId: string) {
  return `${scopeKey(scope)}\u0000${conversationId}`;
}

function normalizeStoredConversationRecord(
  value: unknown,
  scope: AiConversationScope
): AiConversation | null {
  if (!isRecord(value)) return null;
  const conversation = normalizeAiConversation(value);
  const expectedScopeKey = scopeKey(scope);
  if (
    !conversation ||
    value.schema !== AI_CONVERSATION_STORE_SCHEMA ||
    value.scopeKey !== expectedScopeKey ||
    value.key !== conversationKey(scope, conversation.id)
  ) {
    return null;
  }
  return conversation;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb_request_failed")), {
      once: true
    });
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("indexeddb_aborted")), {
      once: true
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("indexeddb_failed")), {
      once: true
    });
  });
}

function boundedConversation(conversation: AiConversation): AiConversation {
  let messages = [...conversation.messages].slice(-MAX_CONVERSATION_MESSAGES);
  let bounded = { ...conversation, messages };
  const serializedBytes = () => new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
  while (messages.length > 0 && serializedBytes() > MAX_CONVERSATION_BYTES) {
    messages = messages.slice(2);
    bounded = { ...conversation, messages };
  }
  if (serializedBytes() > MAX_CONVERSATION_BYTES) {
    throw new Error("ai_conversation_too_large");
  }
  return bounded;
}

export class AiConversationStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly indexedDb: IDBFactory = window.indexedDB) {}

  async load(scope: AiConversationScope): Promise<AiConversationCollection> {
    const database = await this.database();
    const transaction = database.transaction([CONVERSATIONS_STORE, SCOPES_STORE], "readonly");
    const key = scopeKey(scope);
    const recordsRequest = transaction.objectStore(CONVERSATIONS_STORE).index(SCOPE_INDEX).getAll(key);
    const scopeRequest = transaction.objectStore(SCOPES_STORE).get(key);
    const [records, storedScope] = await Promise.all([
      requestResult(recordsRequest),
      requestResult(scopeRequest) as Promise<StoredScopeRecord | undefined>,
      transactionDone(transaction)
    ]);
    const conversations = (records as unknown[])
      .map((record) => normalizeStoredConversationRecord(record, scope))
      .filter((conversation): conversation is AiConversation => conversation !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const activeConversationId = storedScope?.schema === AI_CONVERSATION_STORE_SCHEMA &&
      conversations.some((conversation) => conversation.id === storedScope.activeConversationId)
      ? storedScope.activeConversationId
      : conversations[0]?.id ?? null;
    return { conversations, activeConversationId };
  }

  async save(
    scope: AiConversationScope,
    conversation: AiConversation,
    activeConversationId: string | null = conversation.id
  ) {
    const normalized = normalizeAiConversation(boundedConversation(conversation));
    if (!normalized) throw new Error("ai_conversation_invalid");
    const database = await this.database();
    const transaction = database.transaction([CONVERSATIONS_STORE, SCOPES_STORE], "readwrite");
    const key = scopeKey(scope);
    transaction.objectStore(CONVERSATIONS_STORE).put({
      ...normalized,
      schema: AI_CONVERSATION_STORE_SCHEMA,
      key: conversationKey(scope, normalized.id),
      scopeKey: key
    } satisfies StoredConversationRecord);
    transaction.objectStore(SCOPES_STORE).put({
      schema: AI_CONVERSATION_STORE_SCHEMA,
      scopeKey: key,
      activeConversationId
    } satisfies StoredScopeRecord);
    await transactionDone(transaction);
    await this.enforceLimit(scope);
  }

  async setActive(scope: AiConversationScope, activeConversationId: string | null) {
    const database = await this.database();
    const transaction = database.transaction(SCOPES_STORE, "readwrite");
    transaction.objectStore(SCOPES_STORE).put({
      schema: AI_CONVERSATION_STORE_SCHEMA,
      scopeKey: scopeKey(scope),
      activeConversationId
    } satisfies StoredScopeRecord);
    await transactionDone(transaction);
  }

  async delete(scope: AiConversationScope, conversationId: string, nextActiveId: string | null) {
    const database = await this.database();
    const transaction = database.transaction([CONVERSATIONS_STORE, SCOPES_STORE], "readwrite");
    transaction.objectStore(CONVERSATIONS_STORE).delete(conversationKey(scope, conversationId));
    transaction.objectStore(SCOPES_STORE).put({
      schema: AI_CONVERSATION_STORE_SCHEMA,
      scopeKey: scopeKey(scope),
      activeConversationId: nextActiveId
    } satisfies StoredScopeRecord);
    await transactionDone(transaction);
  }

  private async enforceLimit(scope: AiConversationScope) {
    const collection = await this.load(scope);
    const stale = collection.conversations.slice(MAX_AI_CONVERSATIONS_PER_PROJECT);
    if (stale.length === 0) return;
    const database = await this.database();
    const transaction = database.transaction(CONVERSATIONS_STORE, "readwrite");
    const store = transaction.objectStore(CONVERSATIONS_STORE);
    for (const conversation of stale) store.delete(conversationKey(scope, conversation.id));
    await transactionDone(transaction);
  }

  private database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener("upgradeneeded", () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(CONVERSATIONS_STORE)) {
            const conversations = database.createObjectStore(CONVERSATIONS_STORE, { keyPath: "key" });
            conversations.createIndex(SCOPE_INDEX, "scopeKey", { unique: false });
          }
          if (!database.objectStoreNames.contains(SCOPES_STORE)) {
            database.createObjectStore(SCOPES_STORE, { keyPath: "scopeKey" });
          }
        });
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb_open_failed")), {
          once: true
        });
        request.addEventListener("blocked", () => reject(new Error("indexeddb_open_blocked")), { once: true });
      });
    }
    return this.databasePromise;
  }
}
