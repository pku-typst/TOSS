import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
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
  CircleHelp,
  Copy,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import {
  UiButton,
  UiDialog,
  UiEmptyState,
  UiIconButton,
  UiInput,
  UiSelect,
  UiTextarea
} from "@/components/ui";
import { AssistantMarkdown } from "@/features/ai/AssistantMarkdown";
import {
  activeStoredAiConnection,
  toRuntimeConnection
} from "@/features/ai/connectionStore";
import { useAiAccountConfiguration } from "@/features/ai/accountConfiguration";
import {
  conversationHistory,
  storedMessagesToTranscript,
  type AiConversation
} from "@/features/ai/conversationStore";
import {
  AI_RUNTIME_ENTRY_PATH,
  type AiRuntimeTokenUsage
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
  AiWorkspaceToolPort
} from "@/features/ai/toolContract";
import type { Translator, UiLocale } from "@/lib/i18n";
import type { AuthConfig } from "@/lib/api/types";
import { BUILD_AI_CONNECTION_POLICY } from "@/features/ai/buildPolicy";
import {
  filterManagedModelProfiles,
  localizedAiText,
  shouldShowManagedModelSearch
} from "@/features/ai/managedModelSelection";

type AiAssistantClientConfig = NonNullable<AuthConfig["ai_assistant"]>;
type ManagedAiAssistantClientConfig = Extract<
  AiAssistantClientConfig,
  { kind: "managed_catalog" }
>;

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

function managedProfile(
  config: ManagedAiAssistantClientConfig,
  profileId: string
) {
  return config.model_profiles.find((profile) => profile.id === profileId) ?? null;
}

export { filterManagedModelProfiles, shouldShowManagedModelSearch };

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
          <UiIconButton
            className="ai-message-action"
            tooltip={t("ai.message.copy")}
            label={t("ai.message.copy")}
            onClick={() => void navigator.clipboard?.writeText(copyText)}
          >
            <Copy size={13} aria-hidden />
          </UiIconButton>
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
            group.part.text && (
              <AssistantMarkdown key={group.part.id}>{group.part.text}</AssistantMarkdown>
            )
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
  const sourceKind = usage.contextSource === "estimated" || usage.reportedCalls === 0
    ? "estimated"
    : usage.reportedCalls < usage.providerCalls
      ? "partial"
      : "reported";
  const source = t(`ai.usage.${sourceKind}`);
  const details = t("ai.usage.details", {
    input: usage.inputTokens.toLocaleString(locale),
    output: usage.outputTokens.toLocaleString(locale),
    cacheRead: usage.cacheReadTokens.toLocaleString(locale),
    cacheWrite: usage.cacheWriteTokens.toLocaleString(locale),
    reasoning: usage.reasoningTokens.toLocaleString(locale),
    maxOutput: usage.maxOutputTokens.toLocaleString(locale)
  });
  const context = t("ai.usage.context", {
    used: formatTokenCount(usage.contextTokens, locale),
    limit: formatTokenCount(usage.contextWindow, locale)
  });
  const turn = t("ai.usage.turn", {
    input: formatTokenCount(promptTokens, locale),
    output: formatTokenCount(usage.outputTokens, locale)
  });
  const tooltip = [
    context,
    turn,
    t("ai.usage.calls", { count: usage.providerCalls }),
    source,
    usage.compactedMessages > 0
      ? t("ai.usage.compacted", { count: usage.compactedMessages })
      : null,
    details
  ].filter((value): value is string => value !== null).join(" · ");
  return (
    <div
      className="ai-token-usage"
      data-source={usage.contextSource}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className="ai-token-usage-meter" aria-hidden>
        <span style={{ width: `${percentage}%` }} />
      </span>
      <span>{context}</span>
      <span aria-hidden>·</span>
      <span>{turn}</span>
      {sourceKind !== "reported" && (
        <span className="ai-token-usage-source">{source}</span>
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
  aiAssistantConfig,
  onOpenSettings,
  t
}: {
  width: number;
  accountId: string | null;
  projectId: string;
  locale: UiLocale;
  workspacePort: AiWorkspaceToolPort;
  aiAssistantConfig: AuthConfig["ai_assistant"];
  onOpenSettings: () => void;
  t: Translator;
}) {
  const applicationOrigin = window.location.origin;
  const assistantMenuId = useId();
  const policyMatchesBuild = aiAssistantConfig?.kind === BUILD_AI_CONNECTION_POLICY;
  const managedConfig = policyMatchesBuild && aiAssistantConfig.kind === "managed_catalog"
    ? aiAssistantConfig
    : null;
  const { configuration, setSettings: setAccountSettings } = useAiAccountConfiguration(
    accountId,
    applicationOrigin
  );
  const stored = configuration.connections;
  const accountSettings = configuration.settings;
  const conversations = useAiConversations({
    accountId,
    projectId,
    defaultTitle: t("ai.conversation.untitled")
  });
  const [runtime, setRuntime] = useState(() => ({
    generation: 0,
    client: new AiRuntimeClient(locale, workspacePort, accountSettings.runtime)
  }));
  const [promptDraft, setPromptDraft] = useState("");
  const [managedModelQuery, setManagedModelQuery] = useState("");
  const [renameConversation, setRenameConversation] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteConversation, setDeleteConversation] = useState<AiConversation | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const appliedConversationId = useRef<string | null>(null);
  const connection = useMemo(() => activeStoredAiConnection(stored), [stored]);
  const appliedConnection = useRef(connection);
  const requestedManagedProfileId = managedConfig && accountSettings.managedModelProfileId &&
    managedProfile(managedConfig, accountSettings.managedModelProfileId)
    ? accountSettings.managedModelProfileId
    : managedConfig?.default_model_profile ?? null;
  const client = runtime.client;
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const selectedManagedProfileId = snapshot.managedCatalog?.selectedModelProfileId ??
    requestedManagedProfileId;
  const selectedManagedProfile = managedConfig && selectedManagedProfileId
    ? managedProfile(managedConfig, selectedManagedProfileId)
    : null;
  const availableManagedProfiles = useMemo(() => {
    if (!managedConfig || !snapshot.managedCatalog) return [];
    const available = new Set(snapshot.managedCatalog.availableModelProfileIds);
    return managedConfig.model_profiles.filter((profile) => available.has(profile.id));
  }, [managedConfig, snapshot.managedCatalog]);
  const managedModelSearchVisible = shouldShowManagedModelSearch(
    availableManagedProfiles.length
  );
  const visibleManagedProfiles = useMemo(() => {
    return filterManagedModelProfiles(
      availableManagedProfiles,
      managedModelSearchVisible ? managedModelQuery : "",
      locale
    );
  }, [availableManagedProfiles, locale, managedModelQuery, managedModelSearchVisible]);
  const connectionAvailable = policyMatchesBuild && (
    managedConfig !== null || connection !== null
  );
  const conversationSwitchBlocked = snapshot.status === "running" || snapshot.status === "handshaking";
  const updateConversationTranscript = conversations.updateTranscript;
  const replaceRuntime = useCallback(() => {
    const nextClient = new AiRuntimeClient(locale, workspacePort, accountSettings.runtime);
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
    setRuntime((current) => ({
      generation: current.generation + 1,
      client: nextClient
    }));
    setPromptDraft("");
  }, [accountSettings.runtime, conversations.activeConversation, locale, workspacePort]);

  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => client.setLocale(locale), [client, locale]);
  useEffect(() => {
    if (snapshot.status === "running" || snapshot.status === "handshaking") return;
    client.setPreferences(accountSettings.runtime);
  }, [accountSettings.runtime, client, snapshot.status]);
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
    updateConversationTranscript(
      snapshot.messages,
      snapshot.status !== "running",
      `${runtime.generation}:${snapshot.persistenceRevision}`
    );
  }, [
    conversations.activeConversationId,
    conversations.ready,
    updateConversationTranscript,
    snapshot.conversationId,
    snapshot.messages,
    snapshot.persistenceRevision,
    snapshot.status,
    runtime.generation
  ]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !stickToBottom.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [snapshot.messages]);

  useEffect(() => {
    if (appliedConnection.current === connection) return;
    if (snapshot.status === "running" || snapshot.status === "handshaking") return;
    appliedConnection.current = connection;
    replaceRuntime();
  }, [connection, replaceRuntime, snapshot.status]);

  useEffect(() => {
    if (
      !managedConfig ||
      !requestedManagedProfileId ||
      !snapshot.managedCatalog ||
      snapshot.managedCatalog.selectedModelProfileId === requestedManagedProfileId ||
      snapshot.status === "running" ||
      snapshot.status === "handshaking"
    ) return;
    if (!snapshot.managedCatalog.availableModelProfileIds.includes(requestedManagedProfileId)) {
      const selected = snapshot.managedCatalog.selectedModelProfileId;
      if (selected && accountSettings.managedModelProfileId !== selected) {
        setAccountSettings({ ...accountSettings, managedModelProfileId: selected });
      }
      return;
    }
    client.selectManagedModel(requestedManagedProfileId);
  }, [
    accountSettings,
    client,
    managedConfig,
    requestedManagedProfileId,
    setAccountSettings,
    snapshot.managedCatalog,
    snapshot.status
  ]);

  function selectManagedModel(profileId: string) {
    if (!managedConfig || !managedProfile(managedConfig, profileId)) return;
    if (!client.selectManagedModel(profileId)) return;
    setAccountSettings({
      ...accountSettings,
      managedModelProfileId: profileId
    });
    setManagedModelQuery("");
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

  function closeAssistantMenu() {
    document.getElementById(assistantMenuId)?.hidePopover();
  }

  function openAssistantSettings() {
    if (conversationSwitchBlocked) return;
    closeAssistantMenu();
    onOpenSettings();
  }

  function openAssistantHelp() {
    closeAssistantMenu();
    window.open(
      new URL("/help?topic=ai-assistant", applicationOrigin).toString(),
      "_blank",
      "noopener,noreferrer"
    );
  }

  function renameActiveConversation() {
    const active = conversations.activeConversation;
    if (!active || conversationSwitchBlocked) return;
    closeAssistantMenu();
    setRenameConversation({ id: active.id, title: active.title });
  }

  function deleteActiveConversation() {
    const active = conversations.activeConversation;
    if (!active || conversationSwitchBlocked) return;
    closeAssistantMenu();
    setDeleteConversation(active);
  }

  return (
    <aside className="panel panel-right panel-assistant" style={{ width }}>
      <div className="panel-header ai-assistant-header">
        <h2>{t("workspace.assistant")}</h2>
        <div className="ai-assistant-header-actions">
          {connectionAvailable && (
            <div className="ai-assistant-menu-wrap">
              <nve-button
                className="ai-assistant-menu-trigger"
                role="button"
                container="flat"
                size="sm"
                title={t("ai.menu.open")}
                aria-label={t("ai.menu.open")}
                aria-haspopup="menu"
                popovertarget={assistantMenuId}
              >
                <Ellipsis size={16} aria-hidden />
              </nve-button>
              <nve-dropdown
                id={assistantMenuId}
                className="ai-assistant-menu-dropdown"
                position="bottom"
                alignment="end"
              >
                <nve-menu className="ai-assistant-menu">
                  {conversations.ready && conversations.activeConversation && (
                    <>
                      <nve-menu-item
                        role="menuitem"
                        disabled={conversationSwitchBlocked}
                        onClick={renameActiveConversation}
                      >
                        <Pencil size={14} aria-hidden />
                        <span>{t("ai.conversation.rename")}</span>
                      </nve-menu-item>
                      <nve-menu-item
                        role="menuitem"
                        disabled={conversationSwitchBlocked}
                        onClick={deleteActiveConversation}
                      >
                        <Trash2 size={14} aria-hidden />
                        <span>{t("ai.conversation.delete")}</span>
                      </nve-menu-item>
                    </>
                  )}
                  <nve-menu-item
                    role="menuitem"
                    disabled={conversationSwitchBlocked}
                    onClick={openAssistantSettings}
                  >
                    <SlidersHorizontal size={14} aria-hidden />
                    <span>{t("ai.settings.manage")}</span>
                  </nve-menu-item>
                  <nve-menu-item role="menuitem" onClick={openAssistantHelp}>
                    <CircleHelp size={14} aria-hidden />
                    <span>{t("nav.help")}</span>
                  </nve-menu-item>
                </nve-menu>
              </nve-dropdown>
            </div>
          )}
        </div>
      </div>

      {!policyMatchesBuild && (
        <p className="ai-runtime-error" role="alert">{t("ai.policy.invalid")}</p>
      )}

      {policyMatchesBuild && !connectionAvailable && (
        <UiEmptyState
          className="ai-assistant-setup"
          icon={<Brain size={22} aria-hidden />}
          description={t("ai.settings.connectionRequired")}
          actions={
            <UiButton
              type="button"
              variant="primary"
              data-action="open-assistant-settings"
              onClick={onOpenSettings}
            >
              {t("ai.settings.open")}
            </UiButton>
          }
        />
      )}

      {connectionAvailable && !conversations.ready && (
        <UiEmptyState
          className="ai-transcript-empty"
          icon={<LoaderCircle className="is-spinning" size={18} aria-hidden />}
          description={t("ai.conversation.loading")}
        />
      )}

      {connectionAvailable && conversations.ready && conversations.activeConversation && (
        <div className="ai-active-session">
          <div
            className="ai-conversation-toolbar"
            title={conversations.persistent
              ? t("ai.conversation.browserStorage")
              : t("ai.conversation.memoryStorage")}
          >
            <UiSelect
              className="ai-conversation-select"
              data-testid="ai-conversation-select"
              value={conversations.activeConversation.id}
              aria-label={t("ai.conversation.select")}
              disabled={conversationSwitchBlocked}
              onChange={(event) => selectConversation(event.target.value)}
            >
              {conversations.conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
              ))}
            </UiSelect>
            <UiIconButton
              className="ai-header-button"
              data-testid="ai-conversation-new"
              tooltip={t("ai.conversation.new")}
              label={t("ai.conversation.new")}
              disabled={conversationSwitchBlocked}
              onClick={createConversation}
            >
              <Plus size={14} aria-hidden />
            </UiIconButton>
          </div>
          {conversations.storageError === "conflict" && (
            <p className="ai-runtime-error" role="alert">
              {t("ai.conversation.storageConflict")}
            </p>
          )}
          {managedConfig && selectedManagedProfile ? (
            <div className="ai-connection-summary ai-managed-connection-summary">
              <div>
                <strong>{localizedAiText(managedConfig.provider.label, locale)}</strong>
              </div>
              <div className="ai-managed-model-picker">
                <span>{t("ai.managed.model")}</span>
                {managedModelSearchVisible && (
                  <UiInput
                    type="search"
                    value={managedModelQuery}
                    placeholder={t("ai.managed.searchModels")}
                    aria-label={t("ai.managed.searchModels")}
                    disabled={snapshot.status !== "ready"}
                    onChange={(event) => setManagedModelQuery(event.target.value)}
                  />
                )}
                <UiSelect
                  aria-label={t("ai.managed.model")}
                  value={visibleManagedProfiles.some(
                    (profile) => profile.id === selectedManagedProfile.id
                  ) ? selectedManagedProfile.id : ""}
                  disabled={
                    snapshot.status !== "ready" ||
                    !snapshot.managedCatalog ||
                    snapshot.managedCatalog.availableModelProfileIds.length === 0
                  }
                  onChange={(event) => selectManagedModel(event.target.value)}
                >
                  {visibleManagedProfiles.length === 0 && (
                    <option value="" disabled>{t("ai.managed.noModelsFound")}</option>
                  )}
                  {visibleManagedProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {localizedAiText(profile.label, locale)}
                    </option>
                  ))}
                </UiSelect>
              </div>
            </div>
          ) : connection ? (
            <div className="ai-connection-summary">
              <div>
                <strong>{connection.name}</strong>
                <small>{connection.model}</small>
              </div>
            </div>
          ) : null}
          <div
            className="ai-runtime-frame-wrap"
            hidden={!managedConfig && (snapshot.status === "ready" || snapshot.status === "running")}
          >
            <iframe
              key={`${managedConfig ? "managed" : connection?.id}:${runtime.generation}`}
              className={`ai-runtime-frame ${snapshot.status === "configuring" ? "is-configuring" : ""}`}
              src={AI_RUNTIME_ENTRY_PATH}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
              title={t("ai.connection.frameTitle")}
              onLoad={(event) => client.connect(
                event.currentTarget,
                managedConfig && requestedManagedProfileId
                  ? { kind: "managed", modelProfileId: requestedManagedProfileId }
                  : connection
                    ? toRuntimeConnection(connection)
                    : { kind: "fake" },
                {
                  conversationId: conversations.activeConversation!.id,
                  messages: storedMessagesToTranscript(conversations.activeConversation!.messages),
                  history: conversationHistory(conversations.activeConversation!)
                }
              )}
            />
          </div>
          <div className="ai-transcript-shell">
            <div
              className="ai-transcript"
              ref={transcriptRef}
              onScroll={handleTranscriptScroll}
              aria-busy={snapshot.status === "running"}
            >
              {snapshot.messages.length === 0 ? (
                <UiEmptyState
                  className="ai-transcript-empty"
                  icon={<Brain size={22} aria-hidden />}
                  description={t("ai.empty")}
                />
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
          <p
            className="ai-live-status"
            data-status={snapshot.status}
            role="status"
            aria-live="polite"
          >
            {statusLabel(snapshot.status, t)}
          </p>
          {snapshot.usage && <TokenUsageBar usage={snapshot.usage} locale={locale} t={t} />}
          {snapshot.error && <p className="ai-runtime-error" data-error-code={snapshot.error}>
            {snapshot.errorMessage ?? t("ai.error", { code: snapshot.error })}
          </p>}
          <form className="ai-composer" onSubmit={submitPrompt}>
            <UiTextarea
              className="ai-composer-field"
              name="prompt"
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={t("ai.prompt.placeholder")}
              aria-label={t("ai.prompt.placeholder")}
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
                  data-action="send-prompt"
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
