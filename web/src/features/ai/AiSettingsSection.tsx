import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Bot, SlidersHorizontal } from "lucide-react";
import {
  UiButton,
  UiCard,
  UiCheckbox,
  UiInput,
  UiSectionHeading,
  UiSelect,
  UiTextarea
} from "@/components/ui";
import { useAiAccountConfiguration } from "@/features/ai/accountConfiguration";
import {
  defaultAiAccountSettings,
  type AiAccountSettings
} from "@/features/ai/accountSettingsStore";
import { BUILD_AI_CONNECTION_POLICY } from "@/features/ai/buildPolicy";
import {
  activeStoredAiConnection,
  AI_CONNECTION_STORE_SCHEMA,
  createStoredAiConnection,
  defaultAiConnectionDraft,
  MAX_AI_CONNECTIONS,
  type AiConnectionDraft,
  type StoredAiConnection
} from "@/features/ai/connectionStore";
import {
  filterManagedModelProfiles,
  localizedAiText,
  shouldShowManagedModelSearch
} from "@/features/ai/managedModelSelection";
import {
  formatAiProviderRequestOverrides,
  hasAiProviderRequestOverrides
} from "@/features/ai/providerRequest";
import {
  AI_RUNTIME_MODEL_TOKEN_LIMITS,
  AI_RUNTIME_PROVIDER_PROTOCOLS,
  type AiRuntimeProviderProtocol
} from "@/features/ai/protocol";
import { isAiRuntimePreferences } from "@/features/ai/runtimePreferences";
import type { AuthConfig } from "@/lib/api/types";
import type { Translator, UiLocale } from "@/lib/i18n";

type AiAssistantClientConfig = NonNullable<AuthConfig["ai_assistant"]>;
type ManagedAiAssistantClientConfig = Extract<
  AiAssistantClientConfig,
  { kind: "managed_catalog" }
>;

function secureConnectionId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return `connection-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function protocolLabel(protocol: AiRuntimeProviderProtocol, t: Translator) {
  if (protocol === "openai-completions") return t("ai.protocol.openaiCompletions");
  if (protocol === "openai-responses") return t("ai.protocol.openaiResponses");
  return t("ai.protocol.anthropicMessages");
}

function reasoningCapabilityLabel(reasoning: boolean, t: Translator) {
  return t(reasoning ? "ai.reasoning.declared" : "ai.reasoning.notDeclared");
}

export default function AiSettingsSection({
  accountId,
  locale,
  aiAssistantConfig,
  t
}: {
  accountId: string | null;
  locale: UiLocale;
  aiAssistantConfig: AuthConfig["ai_assistant"];
  t: Translator;
}) {
  const applicationOrigin = window.location.origin;
  const { configuration, setConnections, setSettings } = useAiAccountConfiguration(
    accountId,
    applicationOrigin
  );
  const { connections, settings } = configuration;
  const policyMatchesBuild = aiAssistantConfig?.kind === BUILD_AI_CONNECTION_POLICY;
  const managedConfig = policyMatchesBuild && aiAssistantConfig.kind === "managed_catalog"
    ? aiAssistantConfig as ManagedAiAssistantClientConfig
    : null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<AiConnectionDraft>(
    defaultAiConnectionDraft
  );
  const [connectionError, setConnectionError] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AiAccountSettings>(() => ({
    ...settings,
    runtime: { ...settings.runtime }
  }));
  const [settingsError, setSettingsError] = useState(false);
  const [managedModelQuery, setManagedModelQuery] = useState("");
  const activeConnection = activeStoredAiConnection(connections);
  const selectedManagedProfileId = managedConfig && settings.managedModelProfileId &&
    managedConfig.model_profiles.some((profile) => profile.id === settings.managedModelProfileId)
    ? settings.managedModelProfileId
    : managedConfig?.default_model_profile ?? "";
  const showManagedModelSearch = shouldShowManagedModelSearch(
    managedConfig?.model_profiles.length ?? 0
  );
  const visibleManagedProfiles = useMemo(() => managedConfig
    ? filterManagedModelProfiles(
        managedConfig.model_profiles,
        showManagedModelSearch ? managedModelQuery : "",
        locale
      )
    : [], [locale, managedConfig, managedModelQuery, showManagedModelSearch]);

  useEffect(() => {
    setSettingsDraft({ ...settings, runtime: { ...settings.runtime } });
  }, [settings]);

  function beginAddConnection() {
    setEditingId(null);
    setConnectionDraft(defaultAiConnectionDraft());
    setConnectionError(false);
  }

  function beginEditConnection(connection: StoredAiConnection) {
    setEditingId(connection.id);
    setConnectionDraft({
      name: connection.name,
      protocol: connection.protocol,
      endpoint: connection.endpoint,
      model: connection.model,
      contextWindow: String(connection.contextWindow),
      maxOutputTokens: String(connection.maxOutputTokens),
      reasoning: connection.reasoning,
      requestOverrides: formatAiProviderRequestOverrides(connection.requestOverrides)
    });
    setConnectionError(false);
  }

  function submitConnection(event: FormEvent) {
    event.preventDefault();
    try {
      const id = editingId ?? secureConnectionId();
      const connection = createStoredAiConnection(id, connectionDraft, applicationOrigin);
      const existing = connections.connections.some((item) => item.id === id);
      const nextConnections = existing
        ? connections.connections.map((item) => item.id === id ? connection : item)
        : [...connections.connections, connection];
      if (nextConnections.length > MAX_AI_CONNECTIONS) throw new Error("ai_connection_limit");
      setConnections({
        schema: AI_CONNECTION_STORE_SCHEMA,
        activeConnectionId: id,
        connections: nextConnections
      });
      setEditingId(null);
      setConnectionDraft(defaultAiConnectionDraft());
      setConnectionError(false);
    } catch {
      setConnectionError(true);
    }
  }

  function selectConnection(id: string) {
    setConnections({ ...connections, activeConnectionId: id });
  }

  function removeConnection(id: string) {
    const nextConnections = connections.connections.filter((item) => item.id !== id);
    const activeConnectionId = connections.activeConnectionId === id
      ? nextConnections[0]?.id
      : connections.activeConnectionId;
    setConnections({
      schema: AI_CONNECTION_STORE_SCHEMA,
      ...(activeConnectionId ? { activeConnectionId } : {}),
      connections: nextConnections
    });
    if (editingId === id) beginAddConnection();
  }

  function selectManagedModel(profileId: string) {
    if (!managedConfig?.model_profiles.some((profile) => profile.id === profileId)) return;
    setSettings({ ...settings, managedModelProfileId: profileId });
    setManagedModelQuery("");
  }

  function saveAgentSettings() {
    if (!isAiRuntimePreferences(settingsDraft.runtime)) {
      setSettingsError(true);
      return;
    }
    try {
      setSettings({ ...settings, runtime: { ...settingsDraft.runtime } });
      setSettingsError(false);
    } catch {
      setSettingsError(true);
    }
  }

  if (!policyMatchesBuild) {
    return <p className="ai-runtime-error" role="alert">{t("ai.policy.invalid")}</p>;
  }

  return (
    <div className="ai-settings-section">
      {managedConfig ? (
        <UiCard className="settings-section-card ai-settings-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
          <UiSectionHeading
            icon={<Bot size={18} aria-hidden />}
            title={localizedAiText(managedConfig.provider.label, locale)}
            description={t("ai.settings.managedDescription")}
          />
          {showManagedModelSearch && (
            <UiInput
              label={t("ai.managed.searchModels")}
              type="search"
              value={managedModelQuery}
              onChange={(event) => setManagedModelQuery(event.target.value)}
            />
          )}
          <UiSelect
            label={t("ai.managed.model")}
            value={visibleManagedProfiles.some((profile) => profile.id === selectedManagedProfileId)
              ? selectedManagedProfileId
              : ""}
            onChange={(event) => selectManagedModel(event.target.value)}
          >
            {visibleManagedProfiles.length === 0 && (
              <option value="" disabled>{t("ai.managed.noModelsFound")}</option>
            )}
            {visibleManagedProfiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {localizedAiText(profile.label, locale)}
              </option>
            ))}
          </UiSelect>
        </UiCard>
      ) : (
        <UiCard className="settings-section-card ai-settings-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
          <UiSectionHeading
            icon={<Bot size={18} aria-hidden />}
            title={t("ai.connection.managerTitle")}
            description={t("ai.connection.managerDescription")}
          />
          {connections.connections.length > 0 && (
            <div className="ai-connection-list">
              {connections.connections.map((connection) => (
                <article key={connection.id} className={connection.id === activeConnection?.id ? "is-active" : ""}>
                  <div>
                    <strong>{connection.name}</strong>
                    <small>{protocolLabel(connection.protocol, t)} · {connection.model}</small>
                    <small>{t("ai.connection.tokenSummary", {
                      context: connection.contextWindow.toLocaleString(locale),
                      output: connection.maxOutputTokens.toLocaleString(locale)
                    })}</small>
                    <small>{t("ai.connection.reasoningSummary", {
                      state: reasoningCapabilityLabel(connection.reasoning, t)
                    })} · {t(hasAiProviderRequestOverrides(connection.requestOverrides)
                      ? "ai.connection.requestOverridesConfigured"
                      : "ai.connection.requestOverridesDefault")}</small>
                    <code>{connection.endpoint}</code>
                  </div>
                  <div className="ai-connection-list-actions">
                    <UiButton type="button" size="sm" onClick={() => selectConnection(connection.id)}>
                      {connection.id === activeConnection?.id
                        ? t("ai.connection.active")
                        : t("ai.connection.use")}
                    </UiButton>
                    <UiButton type="button" variant="ghost" size="sm" onClick={() => beginEditConnection(connection)}>
                      {t("common.edit")}
                    </UiButton>
                    <UiButton type="button" variant="ghost" size="sm" onClick={() => removeConnection(connection.id)}>
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
              value={connectionDraft.name}
              maxLength={80}
              required
              onChange={(event) => setConnectionDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <UiSelect
              label={t("ai.connection.protocol")}
              value={connectionDraft.protocol}
              onChange={(event) => setConnectionDraft((current) => ({
                ...current,
                protocol: event.target.value as AiRuntimeProviderProtocol
              }))}
            >
              {AI_RUNTIME_PROVIDER_PROTOCOLS.map((protocol) => (
                <option value={protocol} key={protocol}>{protocolLabel(protocol, t)}</option>
              ))}
            </UiSelect>
            <UiInput
              label={t("ai.connection.endpoint")}
              value={connectionDraft.endpoint}
              type="url"
              maxLength={2_048}
              required
              placeholder="https://example.com/v1"
              onChange={(event) => setConnectionDraft((current) => ({ ...current, endpoint: event.target.value }))}
            />
            <UiInput
              label={t("ai.connection.model")}
              value={connectionDraft.model}
              maxLength={256}
              required
              onChange={(event) => setConnectionDraft((current) => ({ ...current, model: event.target.value }))}
            />
            <UiCheckbox
              label={t("ai.connection.reasoningCapability")}
              checked={connectionDraft.reasoning}
              onChange={(event) => setConnectionDraft((current) => ({
                ...current,
                reasoning: event.target.checked
              }))}
            />
            <p className="ai-connection-note">{t("ai.connection.reasoningCapabilityHint")}</p>
            <UiTextarea
              className="ai-connection-json-field"
              label={t("ai.connection.requestOverrides")}
              value={connectionDraft.requestOverrides}
              rows={6}
              spellCheck={false}
              onChange={(event) => setConnectionDraft((current) => ({
                ...current,
                requestOverrides: event.target.value
              }))}
            />
            <p className="ai-connection-note">{t("ai.connection.requestOverridesHint")}</p>
            <div className="ai-connection-token-fields">
              <UiInput
                label={t("ai.connection.contextWindow")}
                value={connectionDraft.contextWindow}
                type="number"
                inputMode="numeric"
                min={AI_RUNTIME_MODEL_TOKEN_LIMITS.minContextWindow}
                max={AI_RUNTIME_MODEL_TOKEN_LIMITS.maxContextWindow}
                step={1}
                required
                onChange={(event) => setConnectionDraft((current) => ({
                  ...current,
                  contextWindow: event.target.value
                }))}
              />
              <UiInput
                label={t("ai.connection.maxOutputTokens")}
                value={connectionDraft.maxOutputTokens}
                type="number"
                inputMode="numeric"
                min={AI_RUNTIME_MODEL_TOKEN_LIMITS.minMaxOutputTokens}
                max={AI_RUNTIME_MODEL_TOKEN_LIMITS.maxMaxOutputTokens}
                step={1}
                required
                onChange={(event) => setConnectionDraft((current) => ({
                  ...current,
                  maxOutputTokens: event.target.value
                }))}
              />
            </div>
            <p className="ai-connection-note">{t("ai.connection.tokenHint")}</p>
            {!accountId && (
              <p className="ai-connection-note">{t("ai.connection.sessionOnly")}</p>
            )}
            {connectionError && (
              <p className="ai-runtime-error" role="alert">{t("ai.connection.invalid")}</p>
            )}
            <div className="ai-connection-form-actions">
              {editingId && (
                <UiButton type="button" variant="ghost" onClick={beginAddConnection}>
                  {t("common.cancel")}
                </UiButton>
              )}
              <UiButton type="submit" variant="primary">{t("common.save")}</UiButton>
            </div>
          </form>
        </UiCard>
      )}

      <UiCard className="settings-section-card ai-settings-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
        <UiSectionHeading
          icon={<SlidersHorizontal size={18} aria-hidden />}
          title={t("ai.settings.title")}
          description={t("ai.settings.description")}
        />
        <div className="ai-settings-fields">
          <UiInput
            label={t("ai.settings.providerTimeout")}
            type="number"
            inputMode="numeric"
            min={10}
            max={300}
            step={1}
            value={settingsDraft.runtime.providerRequestTimeoutMs / 1_000}
            onChange={(event) => setSettingsDraft((current) => ({
              ...current,
              runtime: { ...current.runtime, providerRequestTimeoutMs: Number(event.target.value) * 1_000 }
            }))}
          />
          <UiInput
            label={t("ai.settings.maxCalls")}
            type="number"
            inputMode="numeric"
            min={1}
            max={32}
            step={1}
            value={settingsDraft.runtime.maxProviderCallsPerTurn}
            onChange={(event) => setSettingsDraft((current) => ({
              ...current,
              runtime: { ...current.runtime, maxProviderCallsPerTurn: Number(event.target.value) }
            }))}
          />
          <UiInput
            label={t("ai.settings.turnTimeout")}
            type="number"
            inputMode="numeric"
            min={30}
            max={900}
            step={1}
            value={settingsDraft.runtime.maxTurnMs / 1_000}
            onChange={(event) => setSettingsDraft((current) => ({
              ...current,
              runtime: { ...current.runtime, maxTurnMs: Number(event.target.value) * 1_000 }
            }))}
          />
          {managedConfig && (
            <UiInput
              label={t("ai.settings.catalogTimeout")}
              type="number"
              inputMode="numeric"
              min={5}
              max={120}
              step={1}
              value={settingsDraft.runtime.catalogRequestTimeoutMs / 1_000}
              onChange={(event) => setSettingsDraft((current) => ({
                ...current,
                runtime: { ...current.runtime, catalogRequestTimeoutMs: Number(event.target.value) * 1_000 }
              }))}
            />
          )}
          <p className="ai-connection-note">
            {t(accountId ? "ai.settings.accountStorage" : "ai.settings.sessionStorage")}
          </p>
          {settingsError && (
            <p className="ai-runtime-error" role="alert">{t("ai.settings.invalid")}</p>
          )}
        </div>
        <div className="ai-settings-actions">
          <UiButton
            type="button"
            onClick={() => setSettingsDraft((current) => ({
              ...current,
              runtime: defaultAiAccountSettings().runtime
            }))}
          >
            {t("ai.settings.reset")}
          </UiButton>
          <UiButton type="button" variant="primary" onClick={saveAgentSettings}>
            {t("common.save")}
          </UiButton>
        </div>
      </UiCard>
    </div>
  );
}
