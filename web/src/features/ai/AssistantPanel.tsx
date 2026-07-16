import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { UiButton, UiCheckbox, UiDialog, UiInput, UiSelect } from "@/components/ui";
import {
  createStoredAiConnection,
  defaultAiConnectionDraft,
  AI_CONNECTION_STORE_SCHEMA,
  loadStoredAiConnections,
  MAX_AI_CONNECTIONS,
  saveStoredAiConnections,
  toRuntimeConnection,
  type AiConnectionDraft,
  type StoredAiConnection,
  type StoredAiConnections
} from "@/features/ai/connectionStore";
import {
  conversationHistory,
  storedMessagesToTranscript,
  type AiConversation
} from "@/features/ai/conversationStore";
import {
  formatAiProviderRequestOverrides,
  hasAiProviderRequestOverrides
} from "@/features/ai/providerRequest";
import {
  AI_RUNTIME_ENTRY_PATH,
  AI_RUNTIME_MODEL_TOKEN_LIMITS,
  AI_RUNTIME_PROVIDER_PROTOCOLS,
  type AiRuntimeTokenUsage,
  type AiRuntimeProviderProtocol
} from "@/features/ai/protocol";
import {
  AiRuntimeClient,
  type AiRuntimeStatus,
  type AiTranscriptContentPart,
  type AiTranscriptMessage,
  type AiTranscriptPart,
  type AiTranscriptToolPart
} from "@/features/ai/runtimeClient";
import { useAiConversations } from "@/features/ai/useAiConversations";
import type {
  AiWorkspaceContextSnapshot,
  AiWorkspaceToolPort
} from "@/features/ai/toolContract";
import type { Translator, UiLocale } from "@/lib/i18n";

type AiActivityPart = AiTranscriptToolPart | (AiTranscriptContentPart & { type: "reasoning" });
type AiTextPart = AiTranscriptContentPart & { type: "text" };
type AiRenderGroup =
  | { type: "text"; part: AiTextPart }
  | { type: "activity"; id: string; parts: AiActivityPart[] };

export type AiTurnActivity =
  | "thinking"
  | "using-tools"
  | "analyzing-tool-results"
  | "responding";

function statusLabel(status: AiRuntimeStatus, t: Translator) {
  if (status === "handshaking") return t("ai.status.handshaking");
  if (status === "configuring") return t("ai.status.configuring");
  if (status === "ready") return t("ai.status.ready");
  if (status === "running") return t("ai.status.running");
  if (status === "error") return t("ai.status.error");
  return t("ai.status.starting");
}

function protocolLabel(protocol: AiRuntimeProviderProtocol, t: Translator) {
  if (protocol === "openai-completions") return t("ai.protocol.openaiCompletions");
  if (protocol === "openai-responses") return t("ai.protocol.openaiResponses");
  return t("ai.protocol.anthropicMessages");
}

function reasoningCapabilityLabel(reasoning: boolean, t: Translator) {
  return t(reasoning ? "ai.reasoning.declared" : "ai.reasoning.notDeclared");
}

function secureConnectionId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return `connection-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function activeConnection(stored: StoredAiConnections) {
  return stored.connections.find((connection) => connection.id === stored.activeConnectionId) ?? null;
}

function renderGroups(parts: readonly AiTranscriptPart[]) {
  const groups: AiRenderGroup[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      groups.push({ type: "text", part: part as AiTextPart });
      continue;
    }
    const activityPart = part as AiActivityPart;
    const previous = groups.at(-1);
    if (previous?.type === "activity") {
      previous.parts.push(activityPart);
    } else {
      groups.push({ type: "activity", id: activityPart.id, parts: [activityPart] });
    }
  }
  return groups;
}

function messageText(message: AiTranscriptMessage) {
  return message.parts
    .filter((part): part is AiTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

export function activeTurnActivity(message: AiTranscriptMessage): AiTurnActivity | null {
  if (message.role !== "assistant" || message.state !== "streaming") return null;
  if (message.parts.some((part) => part.type === "reasoning" && part.state === "streaming")) {
    return "thinking";
  }
  if (message.parts.some((part) => part.type === "tool" && part.state === "running")) {
    return "using-tools";
  }
  if (message.parts.some((part) => part.type === "text" && part.state === "streaming")) {
    return "responding";
  }
  if (message.parts.at(-1)?.type === "tool") return "analyzing-tool-results";
  return "thinking";
}

function turnActivityLabel(activity: AiTurnActivity, t: Translator) {
  if (activity === "using-tools") return t("ai.activity.working");
  if (activity === "analyzing-tool-results") return t("ai.activity.analyzingToolResults");
  if (activity === "responding") return t("ai.activity.responding");
  return t("ai.activity.thinking");
}

function toolLabel(part: AiTranscriptToolPart, t: Translator) {
  if (part.tool === "list_project_files") {
    return part.path
      ? t("ai.tool.listPath", { path: part.path })
      : t("ai.tool.list");
  }
  if (part.tool === "read_project_file") {
    const range = part.startLine
      ? `:${part.startLine}${part.endLine ? `–${part.endLine}` : ""}`
      : "";
    return t("ai.tool.read", { path: `${part.path ?? ""}${range}` });
  }
  if (part.tool === "search_project_text") {
    return t("ai.tool.search", { query: part.query ?? "" });
  }
  if (part.tool === "write_file") {
    return t("ai.tool.write", { path: part.path ?? "" });
  }
  return t("ai.tool.apply", { path: part.path ?? "" });
}

function toolStateLabel(part: AiTranscriptToolPart, t: Translator) {
  if (part.state === "running") return t("ai.tool.running");
  if (part.state === "cancelled") return t("ai.tool.cancelled");
  if (part.state === "error") return t("ai.tool.error");
  if (part.outcome === "accepted") return t("ai.tool.accepted");
  if (part.outcome === "rejected") return t("ai.tool.rejected");
  if (part.outcome === "stale") return t("ai.tool.stale");
  if (part.outcome === "compile_failed") return t("ai.tool.compileFailed");
  return t("ai.tool.complete");
}

function compilationLabel(context: AiWorkspaceContextSnapshot, t: Translator) {
  if (context.workspace_state === "syncing") return t("ai.context.syncing");
  if (context.workspace_state === "offline") return t("ai.context.offline");
  if (context.compilation.state === "running") return t("ai.context.compiling");
  if (context.compilation.state === "failed") {
    return t("ai.context.compileFailed", { count: context.compilation.errors });
  }
  if (context.compilation.state === "succeeded") return t("ai.context.compilePassed");
  if (context.compilation.state === "unavailable") return t("ai.context.compileUnavailable");
  return t("ai.context.compileIdle");
}

function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren, ...props }) => {
            const external = href?.startsWith("https://") || href?.startsWith("http://");
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {linkChildren}
              </a>
            );
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ToolActivity({ part, t }: { part: AiTranscriptToolPart; t: Translator }) {
  const running = part.state === "running";
  const failed = part.state === "error" || part.state === "cancelled" ||
    part.outcome === "compile_failed" || part.outcome === "stale";
  return (
    <div className="ai-tool-activity" data-state={part.state}>
      <span className="ai-activity-icon" aria-hidden>
        {running
          ? <LoaderCircle className="is-spinning" size={14} />
          : failed
            ? <X size={14} />
            : <Check size={14} />}
      </span>
      <div>
        <span>{toolLabel(part, t)}</span>
        <small>{toolStateLabel(part, t)}</small>
      </div>
    </div>
  );
}

function AssistantActivityGroup({
  parts,
  t
}: {
  parts: readonly AiActivityPart[];
  t: Translator;
}) {
  const active = parts.some((part) =>
    part.type === "tool" ? part.state === "running" : part.state === "streaming"
  );
  const hasReasoning = parts.some((part) => part.type === "reasoning");
  const reasoningActive = parts.some(
    (part) => part.type === "reasoning" && part.state === "streaming"
  );
  const [open, setOpen] = useState(active);
  const userControlled = useRef(false);
  useEffect(() => {
    if (!userControlled.current) setOpen(active);
  }, [active]);
  const label = active
    ? reasoningActive ? t("ai.activity.thinking") : t("ai.activity.working")
    : t("ai.activity.completed", { count: parts.length });
  return (
    <section className="ai-activity-group" data-active={active || undefined}>
      <button
        type="button"
        className="ai-activity-trigger"
        aria-expanded={open}
        onClick={() => {
          userControlled.current = true;
          setOpen((value) => !value);
        }}
      >
        {hasReasoning ? <Brain size={14} aria-hidden /> : <Wrench size={14} aria-hidden />}
        <span>{label}</span>
        <ChevronDown className={open ? "is-open" : ""} size={14} aria-hidden />
      </button>
      {open && (
        <div className="ai-activity-content">
          {parts.map((part) => part.type === "tool" ? (
            <ToolActivity key={part.id} part={part} t={t} />
          ) : (
            <div className="ai-reasoning-part" key={part.id} data-state={part.state}>
              <Brain size={14} aria-hidden />
              <div>
                <strong>{part.state === "streaming"
                  ? t("ai.activity.reasoningStreaming")
                  : t("ai.activity.reasoning")}</strong>
                {part.text
                  ? <p>{part.text}</p>
                  : <small>{t("ai.activity.waiting")}</small>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TranscriptMessage({ message, t }: { message: AiTranscriptMessage; t: Translator }) {
  const groups = renderGroups(message.parts);
  const copyText = messageText(message);
  const turnActivity = activeTurnActivity(message);
  return (
    <article
      className={`ai-message ai-message--${message.role}`}
      data-state={message.state}
    >
      <header className="ai-message-header">
        <strong>{message.role === "user" ? t("ai.role.user") : t("ai.role.assistant")}</strong>
        {message.role === "assistant" && copyText && message.state === "complete" && (
          <button
            type="button"
            className="ai-message-action"
            title={t("ai.message.copy")}
            aria-label={t("ai.message.copy")}
            onClick={() => void navigator.clipboard?.writeText(copyText)}
          >
            <Copy size={13} aria-hidden />
          </button>
        )}
      </header>
      {message.role === "user" ? (
        <p className="ai-user-text">{copyText}</p>
      ) : groups.length === 0 && !turnActivity ? (
        <div className="ai-message-pending">
          {message.state === "cancelled"
            ? t("ai.status.cancelled")
            : message.state === "interrupted"
              ? t("ai.status.interrupted")
            : message.state === "error"
              ? t("ai.status.failed")
              : t("ai.status.running")}
        </div>
      ) : (
        <>
          {groups.map((group) => group.type === "text" ? (
            group.part.text && <MarkdownContent key={group.part.id}>{group.part.text}</MarkdownContent>
          ) : (
            <AssistantActivityGroup key={group.id} parts={group.parts} t={t} />
          ))}
          {turnActivity && (
            <div className="ai-turn-activity" data-activity={turnActivity}>
              <LoaderCircle className="is-spinning" size={14} aria-hidden />
              <span>{turnActivityLabel(turnActivity, t)}</span>
            </div>
          )}
        </>
      )}
      {message.state === "cancelled" && groups.length > 0 && (
        <small className="ai-message-outcome">{t("ai.status.cancelled")}</small>
      )}
      {message.state === "interrupted" && groups.length > 0 && (
        <small className="ai-message-outcome">{t("ai.status.interrupted")}</small>
      )}
      {message.state === "error" && groups.length > 0 && (
        <small className="ai-message-outcome is-error">{t("ai.status.failed")}</small>
      )}
    </article>
  );
}

function WorkspaceContextBar({
  context,
  t
}: {
  context: AiWorkspaceContextSnapshot;
  t: Translator;
}) {
  return (
    <div className="ai-workspace-context" title={t("ai.context.entry", {
      path: context.entry_file_path
    })}>
      <span className="ai-workspace-context-path">
        <FileText size={13} aria-hidden />
        <strong>{context.active_path}</strong>
      </span>
      <span className={`ai-workspace-context-status is-${context.compilation.state}`}>
        {context.project_type === "typst" ? "Typst" : "LaTeX"}
        <span aria-hidden>·</span>
        {compilationLabel(context, t)}
      </span>
    </div>
  );
}

function formatTokenCount(value: number, locale: UiLocale) {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function TokenUsageBar({
  usage,
  locale,
  t
}: {
  usage: AiRuntimeTokenUsage;
  locale: UiLocale;
  t: Translator;
}) {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const percentage = Math.min(100, (usage.contextTokens / usage.contextWindow) * 100);
  const source = usage.contextSource === "estimated" || usage.reportedCalls === 0
    ? t("ai.usage.estimated")
    : usage.reportedCalls < usage.providerCalls
      ? t("ai.usage.partial")
      : t("ai.usage.reported");
  const details = t("ai.usage.details", {
    input: usage.inputTokens.toLocaleString(locale),
    output: usage.outputTokens.toLocaleString(locale),
    cacheRead: usage.cacheReadTokens.toLocaleString(locale),
    cacheWrite: usage.cacheWriteTokens.toLocaleString(locale),
    reasoning: usage.reasoningTokens.toLocaleString(locale),
    maxOutput: usage.maxOutputTokens.toLocaleString(locale)
  });
  return (
    <div className="ai-token-usage" data-source={usage.contextSource} title={details}>
      <span className="ai-token-usage-meter" aria-hidden>
        <span style={{ width: `${percentage}%` }} />
      </span>
      <span>{t("ai.usage.context", {
        used: formatTokenCount(usage.contextTokens, locale),
        limit: formatTokenCount(usage.contextWindow, locale)
      })}</span>
      <span aria-hidden>·</span>
      <span>{t("ai.usage.turn", {
        input: formatTokenCount(promptTokens, locale),
        output: formatTokenCount(usage.outputTokens, locale)
      })}</span>
      <span aria-hidden>·</span>
      <span>{t("ai.usage.calls", { count: usage.providerCalls })}</span>
      <span className="ai-token-usage-source">{source}</span>
      {usage.compactedMessages > 0 && (
        <span>{t("ai.usage.compacted", { count: usage.compactedMessages })}</span>
      )}
    </div>
  );
}

export default function AssistantPanel({
  width,
  accountId,
  projectId,
  locale,
  workspacePort,
  t
}: {
  width: number;
  accountId: string | null;
  projectId: string;
  locale: UiLocale;
  workspacePort: AiWorkspaceToolPort;
  t: Translator;
}) {
  const applicationOrigin = window.location.origin;
  const [stored, setStored] = useState(() =>
    loadStoredAiConnections(accountId, applicationOrigin)
  );
  const initialConnection = activeConnection(stored);
  const [managerOpen, setManagerOpen] = useState(!initialConnection);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiConnectionDraft>(defaultAiConnectionDraft);
  const [connectionError, setConnectionError] = useState(false);
  const conversations = useAiConversations({
    accountId,
    projectId,
    defaultTitle: t("ai.conversation.untitled")
  });
  const [runtime, setRuntime] = useState(() => ({
    generation: 0,
    client: new AiRuntimeClient(locale, workspacePort)
  }));
  const [promptDraft, setPromptDraft] = useState("");
  const [renameConversation, setRenameConversation] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteConversation, setDeleteConversation] = useState<AiConversation | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const appliedConversationId = useRef<string | null>(null);
  const connection = useMemo(() => activeConnection(stored), [stored]);
  const client = runtime.client;
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const workspaceContext = workspacePort.getContextSnapshot();
  const conversationSwitchBlocked = snapshot.status === "running" || snapshot.status === "handshaking";
  const updateConversationTranscript = conversations.updateTranscript;

  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => client.setLocale(locale), [client, locale]);
  useLayoutEffect(() => {
    const conversation = conversations.activeConversation;
    if (!conversations.ready || !conversation || appliedConversationId.current === conversation.id) return;
    if (client.setConversation(
      conversation.id,
      storedMessagesToTranscript(conversation.messages),
      conversationHistory(conversation)
    )) {
      appliedConversationId.current = conversation.id;
      stickToBottom.current = true;
    }
  }, [client, conversations.activeConversation, conversations.ready, snapshot.status]);
  useEffect(() => {
    if (
      !conversations.ready ||
      snapshot.conversationId !== conversations.activeConversationId
    ) return;
    updateConversationTranscript(snapshot.messages, snapshot.status !== "running");
  }, [
    conversations.activeConversationId,
    conversations.ready,
    updateConversationTranscript,
    snapshot.conversationId,
    snapshot.messages,
    snapshot.status
  ]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottom.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [snapshot.messages]);

  function replaceRuntime() {
    setRuntime((current) => {
      current.client.dispose();
      const nextClient = new AiRuntimeClient(locale, workspacePort);
      const conversation = conversations.activeConversation;
      if (conversation) {
        nextClient.setConversation(
          conversation.id,
          storedMessagesToTranscript(conversation.messages),
          conversationHistory(conversation)
        );
        appliedConversationId.current = conversation.id;
      } else {
        appliedConversationId.current = null;
      }
      return {
        generation: current.generation + 1,
        client: nextClient
      };
    });
    setPromptDraft("");
  }

  function persist(next: StoredAiConnections) {
    setStored(next);
    saveStoredAiConnections(accountId, next);
  }

  function submitConnection(event: FormEvent) {
    event.preventDefault();
    try {
      const id = editingId ?? secureConnectionId();
      const nextConnection = createStoredAiConnection(id, draft, applicationOrigin);
      const existing = stored.connections.findIndex((item) => item.id === id);
      const connections = existing >= 0
        ? stored.connections.map((item) => item.id === id ? nextConnection : item)
        : [...stored.connections, nextConnection];
      if (connections.length > MAX_AI_CONNECTIONS) throw new Error("ai_connection_limit");
      persist({ schema: AI_CONNECTION_STORE_SCHEMA, activeConnectionId: id, connections });
      setConnectionError(false);
      setEditingId(null);
      setDraft(defaultAiConnectionDraft());
      setManagerOpen(false);
      replaceRuntime();
    } catch {
      setConnectionError(true);
    }
  }

  function beginAddConnection() {
    setEditingId(null);
    setDraft(defaultAiConnectionDraft());
    setConnectionError(false);
    setManagerOpen(true);
  }

  function beginEditConnection(item: StoredAiConnection) {
    setEditingId(item.id);
    setDraft({
      name: item.name,
      protocol: item.protocol,
      endpoint: item.endpoint,
      model: item.model,
      contextWindow: String(item.contextWindow),
      maxOutputTokens: String(item.maxOutputTokens),
      reasoning: item.reasoning,
      requestOverrides: formatAiProviderRequestOverrides(item.requestOverrides)
    });
    setConnectionError(false);
    setManagerOpen(true);
  }

  function selectConnection(id: string) {
    if (stored.activeConnectionId === id) {
      setManagerOpen(false);
      return;
    }
    persist({ ...stored, activeConnectionId: id });
    setManagerOpen(false);
    replaceRuntime();
  }

  function removeConnection(id: string) {
    const connections = stored.connections.filter((item) => item.id !== id);
    const removedActive = stored.activeConnectionId === id;
    const activeConnectionId = removedActive ? connections[0]?.id : stored.activeConnectionId;
    persist({
      schema: AI_CONNECTION_STORE_SCHEMA,
      ...(activeConnectionId ? { activeConnectionId } : {}),
      connections
    });
    if (editingId === id) {
      setEditingId(null);
      setDraft(defaultAiConnectionDraft());
    }
    if (removedActive) replaceRuntime();
    if (connections.length === 0) setManagerOpen(true);
  }

  function submitPrompt(event: FormEvent) {
    event.preventDefault();
    const prompt = promptDraft.trim();
    if (client.startTurn(prompt)) {
      conversations.titleFromPrompt(prompt);
      setPromptDraft("");
    }
  }

  function applyConversation(conversation: AiConversation | null) {
    if (!conversation) return;
    if (client.setConversation(
      conversation.id,
      storedMessagesToTranscript(conversation.messages),
      conversationHistory(conversation)
    )) {
      appliedConversationId.current = conversation.id;
      stickToBottom.current = true;
      setShowJumpToLatest(false);
      setPromptDraft("");
    }
  }

  function selectConversation(conversationId: string) {
    if (conversationSwitchBlocked) return;
    applyConversation(conversations.select(conversationId));
  }

  function createConversation() {
    if (conversationSwitchBlocked) return;
    applyConversation(conversations.create());
  }

  function submitConversationRename() {
    if (!renameConversation) return;
    if (conversations.rename(renameConversation.id, renameConversation.title)) {
      setRenameConversation(null);
    }
  }

  function confirmConversationDelete() {
    if (!deleteConversation || conversationSwitchBlocked) return;
    applyConversation(conversations.remove(deleteConversation.id));
    setDeleteConversation(null);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function handleTranscriptScroll() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    stickToBottom.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }

  function jumpToLatest() {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    stickToBottom.current = true;
    setShowJumpToLatest(false);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth"
    });
  }

  return (
    <aside className="panel panel-right panel-assistant" style={{ width }}>
      <div className="panel-header ai-assistant-header">
        <h2>{t("workspace.assistant")}</h2>
        <div className="ai-assistant-header-actions">
          <span className={`ai-runtime-state ai-runtime-state--${snapshot.status}`}>
            {connection ? statusLabel(snapshot.status, t) : t("ai.status.connectionRequired")}
          </span>
          {connection && (
            <button
              type="button"
              className="ai-header-button"
              title={t("ai.connection.manage")}
              aria-label={t("ai.connection.manage")}
              onClick={() => setManagerOpen(true)}
            >
              <Settings2 size={14} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {managerOpen && (
        <section className="ai-connection-manager" aria-label={t("ai.connection.managerTitle")}>
          <div className="ai-connection-manager-heading">
            <div>
              <h3>{t("ai.connection.managerTitle")}</h3>
              <p>{t("ai.connection.managerDescription")}</p>
            </div>
            {connection && (
              <UiButton type="button" variant="ghost" size="sm" onClick={() => setManagerOpen(false)}>
                {t("common.close")}
              </UiButton>
            )}
          </div>
          {stored.connections.length > 0 && (
            <div className="ai-connection-list">
              {stored.connections.map((item) => (
                <article key={item.id} className={item.id === stored.activeConnectionId ? "is-active" : ""}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{protocolLabel(item.protocol, t)} · {item.model}</small>
                    <small>{t("ai.connection.tokenSummary", {
                      context: formatTokenCount(item.contextWindow, locale),
                      output: formatTokenCount(item.maxOutputTokens, locale)
                    })}</small>
                    <small>{t("ai.connection.reasoningSummary", {
                      state: reasoningCapabilityLabel(item.reasoning, t)
                    })} · {t(hasAiProviderRequestOverrides(item.requestOverrides)
                      ? "ai.connection.requestOverridesConfigured"
                      : "ai.connection.requestOverridesDefault")}</small>
                    <code>{item.endpoint}</code>
                  </div>
                  <div className="ai-connection-list-actions">
                    <UiButton type="button" size="sm" onClick={() => selectConnection(item.id)}>
                      {item.id === stored.activeConnectionId ? t("ai.connection.active") : t("ai.connection.use")}
                    </UiButton>
                    <UiButton type="button" variant="ghost" size="sm" onClick={() => beginEditConnection(item)}>
                      {t("common.edit")}
                    </UiButton>
                    <UiButton type="button" variant="ghost" size="sm" onClick={() => removeConnection(item.id)}>
                      {t("common.remove")}
                    </UiButton>
                  </div>
                </article>
              ))}
            </div>
          )}
          <form className="ai-connection-form" onSubmit={submitConnection}>
            <h4>{editingId ? t("ai.connection.editTitle") : t("ai.connection.addTitle")}</h4>
            <UiInput
              label={t("ai.connection.name")}
              value={draft.name}
              maxLength={80}
              required
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <UiSelect
              label={t("ai.connection.protocol")}
              value={draft.protocol}
              onChange={(event) => setDraft((current) => ({
                ...current,
                protocol: event.target.value as AiRuntimeProviderProtocol
              }))}
            >
              {AI_RUNTIME_PROVIDER_PROTOCOLS.map((protocol) => (
                <option key={protocol} value={protocol}>{protocolLabel(protocol, t)}</option>
              ))}
            </UiSelect>
            <UiInput
              label={t("ai.connection.endpoint")}
              value={draft.endpoint}
              type="url"
              maxLength={2_048}
              required
              placeholder="https://example.com/v1"
              onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
            />
            <UiInput
              label={t("ai.connection.model")}
              value={draft.model}
              maxLength={256}
              required
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            />
            <UiCheckbox
              label={t("ai.connection.reasoningCapability")}
              checked={draft.reasoning}
              onChange={(event) => setDraft((current) => ({
                ...current,
                reasoning: event.target.checked
              }))}
            />
            <p className="ai-connection-note">{t("ai.connection.reasoningCapabilityHint")}</p>
            <label className="ai-connection-json-field">
              <span>{t("ai.connection.requestOverrides")}</span>
              <textarea
                value={draft.requestOverrides}
                rows={6}
                spellCheck={false}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  requestOverrides: event.target.value
                }))}
              />
            </label>
            <p className="ai-connection-note">{t("ai.connection.requestOverridesHint")}</p>
            <div className="ai-connection-token-fields">
              <UiInput
                label={t("ai.connection.contextWindow")}
                value={draft.contextWindow}
                type="number"
                inputMode="numeric"
                min={AI_RUNTIME_MODEL_TOKEN_LIMITS.minContextWindow}
                max={AI_RUNTIME_MODEL_TOKEN_LIMITS.maxContextWindow}
                step={1}
                required
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  contextWindow: event.target.value
                }))}
              />
              <UiInput
                label={t("ai.connection.maxOutputTokens")}
                value={draft.maxOutputTokens}
                type="number"
                inputMode="numeric"
                min={AI_RUNTIME_MODEL_TOKEN_LIMITS.minMaxOutputTokens}
                max={AI_RUNTIME_MODEL_TOKEN_LIMITS.maxMaxOutputTokens}
                step={1}
                required
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  maxOutputTokens: event.target.value
                }))}
              />
            </div>
            <p className="ai-connection-note">{t("ai.connection.tokenHint")}</p>
            {connectionError && <p className="ai-runtime-error" role="alert">{t("ai.connection.invalid")}</p>}
            {!accountId && <p className="ai-connection-note">{t("ai.connection.sessionOnly")}</p>}
            <div className="ai-connection-form-actions">
              {editingId && (
                <UiButton type="button" variant="ghost" onClick={beginAddConnection}>
                  {t("common.cancel")}
                </UiButton>
              )}
              <UiButton type="submit" variant="primary">
                {t("common.save")}
              </UiButton>
            </div>
          </form>
        </section>
      )}

      {connection && !conversations.ready && !managerOpen && (
        <div className="ai-transcript-empty">
          <LoaderCircle className="is-spinning" size={18} aria-hidden />
          <p>{t("ai.conversation.loading")}</p>
        </div>
      )}

      {connection && conversations.ready && conversations.activeConversation && (
        <div className="ai-active-session" hidden={managerOpen}>
          <div
            className="ai-conversation-toolbar"
            title={conversations.persistent
              ? t("ai.conversation.browserStorage")
              : t("ai.conversation.memoryStorage")}
          >
            <select
              data-testid="ai-conversation-select"
              value={conversations.activeConversation.id}
              aria-label={t("ai.conversation.select")}
              disabled={conversationSwitchBlocked}
              onChange={(event) => selectConversation(event.target.value)}
            >
              {conversations.conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
              ))}
            </select>
            <button
              type="button"
              className="ai-header-button"
              data-testid="ai-conversation-new"
              title={t("ai.conversation.new")}
              aria-label={t("ai.conversation.new")}
              disabled={conversationSwitchBlocked}
              onClick={createConversation}
            >
              <Plus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ai-header-button"
              title={t("ai.conversation.rename")}
              aria-label={t("ai.conversation.rename")}
              disabled={conversationSwitchBlocked}
              onClick={() => setRenameConversation({
                id: conversations.activeConversation!.id,
                title: conversations.activeConversation!.title
              })}
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ai-header-button"
              title={t("ai.conversation.delete")}
              aria-label={t("ai.conversation.delete")}
              disabled={conversationSwitchBlocked}
              onClick={() => setDeleteConversation(conversations.activeConversation)}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
          <div className="ai-connection-summary">
            <div>
              <strong>{connection.name}</strong>
              <small>{connection.model} · {t("ai.connection.tokenSummary", {
                context: formatTokenCount(connection.contextWindow, locale),
                output: formatTokenCount(connection.maxOutputTokens, locale)
              })} · {reasoningCapabilityLabel(connection.reasoning, t)}</small>
            </div>
            <span className="ai-connection-protocol">{protocolLabel(connection.protocol, t)}</span>
          </div>
          <WorkspaceContextBar context={workspaceContext} t={t} />
          <div
            className="ai-runtime-frame-wrap"
            hidden={snapshot.status === "ready" || snapshot.status === "running"}
          >
            <iframe
              key={`${connection.id}:${runtime.generation}`}
              className={`ai-runtime-frame ${snapshot.status === "configuring" ? "is-configuring" : ""}`}
              src={AI_RUNTIME_ENTRY_PATH}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
              title={t("ai.runtime.title")}
              onLoad={(event) => client.connect(
                event.currentTarget,
                toRuntimeConnection(connection),
                {
                  conversationId: conversations.activeConversation!.id,
                  messages: storedMessagesToTranscript(conversations.activeConversation!.messages),
                  history: conversationHistory(conversations.activeConversation!)
                }
              )}
            />
            <p className="ai-prototype-notice">{t("ai.connection.credentialNotice")}</p>
          </div>
          <div className="ai-transcript-shell">
            <div
              className="ai-transcript"
              ref={transcriptRef}
              onScroll={handleTranscriptScroll}
              aria-busy={snapshot.status === "running"}
            >
              {snapshot.messages.length === 0 ? (
                <div className="ai-transcript-empty">
                  <Brain size={22} aria-hidden />
                  <p>{t("ai.empty")}</p>
                  <small>{t("ai.emptyHint")}</small>
                </div>
              ) : (
                snapshot.messages.map((message) => (
                  <TranscriptMessage key={message.id} message={message} t={t} />
                ))
              )}
            </div>
            {showJumpToLatest && (
              <button type="button" className="ai-jump-latest" onClick={jumpToLatest}>
                <ChevronDown size={14} aria-hidden />
                {t("ai.jumpLatest")}
              </button>
            )}
          </div>
          <p className="ai-live-status" role="status" aria-live="polite">
            {statusLabel(snapshot.status, t)}
          </p>
          {snapshot.usage && <TokenUsageBar usage={snapshot.usage} locale={locale} t={t} />}
          {snapshot.error && <p className="ai-runtime-error">
            {snapshot.errorMessage ?? t("ai.error", { code: snapshot.error })}
          </p>}
          <form className="ai-composer" onSubmit={submitPrompt}>
            <textarea
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={t("ai.prompt.placeholder")}
              disabled={snapshot.status !== "ready"}
              rows={3}
            />
            <div className="ai-composer-actions">
              <small>{t("ai.prompt.hint")}</small>
              {snapshot.status === "error" && (
                <UiButton type="button" onClick={replaceRuntime}>
                  {t("common.retry")}
                </UiButton>
              )}
              {snapshot.status === "running" ? (
                <UiButton key="cancel-turn" type="button" onClick={() => client.cancelTurn()}>
                  {t("common.cancel")}
                </UiButton>
              ) : (
                <UiButton
                  key="start-turn"
                  type="submit"
                  variant="primary"
                  disabled={snapshot.status !== "ready" || !promptDraft.trim()}
                >
                  {t("ai.send")}
                </UiButton>
              )}
            </div>
          </form>
        </div>
      )}
      <UiDialog
        open={!!renameConversation}
        title={t("ai.conversation.renameTitle")}
        onClose={() => setRenameConversation(null)}
        actions={
          <>
            <UiButton onClick={() => setRenameConversation(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              disabled={!renameConversation?.title.trim()}
              onClick={submitConversationRename}
            >
              {t("common.save")}
            </UiButton>
          </>
        }
      >
        <UiInput
          label={t("ai.conversation.name")}
          maxLength={80}
          value={renameConversation?.title ?? ""}
          onChange={(event) => setRenameConversation((current) => current
            ? { ...current, title: event.target.value }
            : current)}
        />
      </UiDialog>
      <UiDialog
        open={!!deleteConversation}
        title={t("ai.conversation.deleteTitle")}
        description={deleteConversation
          ? t("ai.conversation.deleteDescription", { title: deleteConversation.title })
          : undefined}
        onClose={() => setDeleteConversation(null)}
        actions={
          <>
            <UiButton onClick={() => setDeleteConversation(null)}>{t("common.cancel")}</UiButton>
            <UiButton variant="danger" onClick={confirmConversationDelete}>
              {t("common.remove")}
            </UiButton>
          </>
        }
      />
    </aside>
  );
}
