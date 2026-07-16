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
  hasAiProviderRequestOverrides,
  parseAiProviderRequestOverrides
} from "@/features/ai/providerRequest";
import {
  createManagedCustomProfile,
  isManagedCustomProfileWithinPolicy,
  managedCustomProfilesForConfig,
  requestedManagedSelection
} from "@/features/ai/managedCustomProfiles";
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

type ManagedCustomProfileDraft = {
  contextWindow: string;
  maxOutputTokens: string;
  reasoning: boolean;
  requestOverrides: string;
};

const EMPTY_MANAGED_CUSTOM_DRAFT: ManagedCustomProfileDraft = {
  contextWindow: "",
  maxOutputTokens: "",
  reasoning: false,
  requestOverrides: "{}"
};

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
  const [managedCustomDraft, setManagedCustomDraft] = useState<ManagedCustomProfileDraft>(
    EMPTY_MANAGED_CUSTOM_DRAFT
  );
  const [managedCustomError, setManagedCustomError] = useState(false);
  const activeConnection = activeStoredAiConnection(connections);
  const effectiveManagedSelection = managedConfig
    ? requestedManagedSelection(managedConfig, settings)
    : null;
  const managedCustomProfiles = useMemo(() => managedConfig
    ? managedCustomProfilesForConfig(managedConfig, settings)
    : [], [managedConfig, settings]);
  const selectedManagedIdentity = effectiveManagedSelection ? {
    kind: effectiveManagedSelection.kind,
    profileId: effectiveManagedSelection.profileId
  } : null;
  const selectedCustomProfile = effectiveManagedSelection?.kind === "custom"
    ? managedCustomProfiles.find(
        (profile) => profile.profileId === effectiveManagedSelection.profileId
      ) ?? null
    : null;
  const showManagedModelSearch = shouldShowManagedModelSearch(
    (managedConfig?.model_profiles.length ?? 0) +
      (managedConfig?.custom_profiles.enabled
        ? managedCustomProfiles.length
        : 0)
  );
  const visibleManagedProfiles = useMemo(() => managedConfig
    ? filterManagedModelProfiles(
        managedConfig.model_profiles,
        showManagedModelSearch ? managedModelQuery : "",
        locale
      )
    : [], [locale, managedConfig, managedModelQuery, showManagedModelSearch]);
  const visibleManagedCustomProfiles = useMemo(() => {
    const profiles = managedConfig?.custom_profiles.enabled
      ? managedCustomProfiles
      : [];
    const query = showManagedModelSearch ? managedModelQuery.trim().toLocaleLowerCase(locale) : "";
    return query
      ? profiles.filter((profile) => profile.model.toLocaleLowerCase(locale).includes(query))
      : profiles;
  }, [
    locale,
    managedConfig?.custom_profiles.enabled,
    managedModelQuery,
    managedCustomProfiles,
    showManagedModelSearch
  ]);

  useEffect(() => {
    setSettingsDraft({ ...settings, runtime: { ...settings.runtime } });
  }, [settings]);

  useEffect(() => {
    setManagedCustomDraft(selectedCustomProfile ? {
      contextWindow: String(selectedCustomProfile.contextWindow),
      maxOutputTokens: String(selectedCustomProfile.maxOutputTokens),
      reasoning: selectedCustomProfile.reasoning,
      requestOverrides: formatAiProviderRequestOverrides(selectedCustomProfile.requestOverrides)
    } : EMPTY_MANAGED_CUSTOM_DRAFT);
    setManagedCustomError(false);
  }, [selectedCustomProfile]);

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

  function selectManagedModel(value: string) {
    if (!managedConfig) return;
    const separator = value.indexOf(":");
    if (separator < 0) return;
    const kind = value.slice(0, separator);
    const profileId = value.slice(separator + 1);
    if (kind === "recommended" && !managedConfig.model_profiles.some(
      (profile) => profile.id === profileId
    )) return;
    if (kind === "custom" && !managedCustomProfiles.some(
      (profile) => profile.profileId === profileId
    )) return;
    if (kind !== "recommended" && kind !== "custom") return;
    setSettings({
      ...settings,
      managedModelSelection: { kind, profileId }
    });
    setManagedModelQuery("");
  }

  function saveManagedCustomProfile() {
    if (!managedConfig || !selectedCustomProfile) return;
    const requestOverrides = parseAiProviderRequestOverrides(
      managedCustomDraft.requestOverrides
    );
    const updated = {
      ...selectedCustomProfile,
      contextWindow: Number(managedCustomDraft.contextWindow),
      maxOutputTokens: Number(managedCustomDraft.maxOutputTokens),
      reasoning: managedCustomDraft.reasoning,
      ...(requestOverrides ? { requestOverrides } : {})
    };
    if (!requestOverrides || !isManagedCustomProfileWithinPolicy(managedConfig, updated)) {
      setManagedCustomError(true);
      return;
    }
    try {
      setSettings({
        ...settings,
        managedCustomProfiles: managedCustomProfiles.map((profile) =>
          profile.profileId === updated.profileId ? updated : profile
        )
      });
      setManagedCustomError(false);
    } catch {
      setManagedCustomError(true);
    }
  }

  function customizeSelectedRecommendation() {
    if (
      !managedConfig?.custom_profiles.enabled ||
      effectiveManagedSelection?.kind !== "recommended"
    ) return;
    const recommendation = managedConfig.model_profiles.find(
      (profile) => profile.id === effectiveManagedSelection.profileId
    );
    if (!recommendation) return;
    const profiles = managedCustomProfiles;
    const existing = profiles.find((profile) => profile.model === recommendation.model);
    if (existing) {
      setSettings({
        ...settings,
        managedModelSelection: { kind: "custom", profileId: existing.profileId }
      });
      return;
    }
    if (profiles.length >= managedConfig.custom_profiles.max_saved_profiles) {
      setManagedCustomError(true);
      return;
    }
    const profile = createManagedCustomProfile(managedConfig, { id: recommendation.model });
    if (!profile) {
      setManagedCustomError(true);
      return;
    }
    try {
      setSettings({
        ...settings,
        managedModelSelection: { kind: "custom", profileId: profile.profileId },
        managedCustomProfiles: [...profiles, profile]
      });
      setManagedCustomError(false);
    } catch {
      setManagedCustomError(true);
    }
  }

  function removeManagedCustomProfile() {
    if (!managedConfig || !selectedCustomProfile) return;
    setSettings({
      ...settings,
      managedModelSelection: {
        kind: "recommended",
        profileId: managedConfig.default_model_profile
      },
      managedCustomProfiles: managedCustomProfiles.filter(
        (profile) => profile.profileId !== selectedCustomProfile.profileId
      )
    });
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
            value={selectedManagedIdentity
              ? `${selectedManagedIdentity.kind}:${selectedManagedIdentity.profileId}`
              : ""}
            onChange={(event) => selectManagedModel(event.target.value)}
          >
            {visibleManagedProfiles.length === 0 && visibleManagedCustomProfiles.length === 0 && (
              <option value="" disabled>{t("ai.managed.noModelsFound")}</option>
            )}
            {visibleManagedProfiles.length > 0 && (
              <optgroup label={t("ai.managed.recommendedModels")}>
                {visibleManagedProfiles.map((profile) => (
                  <option value={`recommended:${profile.id}`} key={profile.id}>
                    {localizedAiText(profile.label, locale)}
                  </option>
                ))}
              </optgroup>
            )}
            {visibleManagedCustomProfiles.length > 0 && (
              <optgroup label={t("ai.managed.savedCustomModels")}>
                {visibleManagedCustomProfiles.map((profile) => (
                  <option value={`custom:${profile.profileId}`} key={profile.profileId}>
                    {profile.model}
                  </option>
                ))}
              </optgroup>
            )}
          </UiSelect>
          {managedConfig.custom_profiles.enabled &&
            effectiveManagedSelection?.kind === "recommended" && (
            <div className="ai-connection-form-actions">
              <UiButton type="button" onClick={customizeSelectedRecommendation}>
                {t("ai.managed.customize")}
              </UiButton>
            </div>
          )}
          {selectedCustomProfile && (
            <div className="ai-connection-form">
              <p className="ai-connection-note">{t("ai.managed.customizedHint")}</p>
              <UiInput
                label={t("ai.connection.model")}
                value={selectedCustomProfile.model}
                disabled
              />
              <UiCheckbox
                label={t("ai.connection.reasoningCapability")}
                checked={managedCustomDraft.reasoning}
                onChange={(event) => setManagedCustomDraft((current) => ({
                  ...current,
                  reasoning: event.target.checked
                }))}
              />
              <UiTextarea
                className="ai-connection-json-field"
                label={t("ai.connection.requestOverrides")}
                value={managedCustomDraft.requestOverrides}
                rows={6}
                spellCheck={false}
                onChange={(event) => setManagedCustomDraft((current) => ({
                  ...current,
                  requestOverrides: event.target.value
                }))}
              />
              <p className="ai-connection-note">{t("ai.connection.requestOverridesHint")}</p>
              <div className="ai-connection-token-fields">
                <UiInput
                  label={t("ai.connection.contextWindow")}
                  value={managedCustomDraft.contextWindow}
                  type="number"
                  inputMode="numeric"
                  min={managedConfig.custom_profiles.limits.min_context_window}
                  max={managedConfig.custom_profiles.limits.max_context_window}
                  step={1}
                  onChange={(event) => setManagedCustomDraft((current) => ({
                    ...current,
                    contextWindow: event.target.value
                  }))}
                />
                <UiInput
                  label={t("ai.connection.maxOutputTokens")}
                  value={managedCustomDraft.maxOutputTokens}
                  type="number"
                  inputMode="numeric"
                  min={managedConfig.custom_profiles.limits.min_output_tokens}
                  max={managedConfig.custom_profiles.limits.max_output_tokens}
                  step={1}
                  onChange={(event) => setManagedCustomDraft((current) => ({
                    ...current,
                    maxOutputTokens: event.target.value
                  }))}
                />
              </div>
              <p className="ai-connection-note">{t("ai.connection.tokenHint")}</p>
              <div className="ai-connection-form-actions">
                <UiButton type="button" variant="ghost" onClick={removeManagedCustomProfile}>
                  {t("common.remove")}
                </UiButton>
                <UiButton type="button" variant="primary" onClick={saveManagedCustomProfile}>
                  {t("common.save")}
                </UiButton>
              </div>
            </div>
          )}
          {managedCustomError && (
            <p className="ai-runtime-error" role="alert">
              {t("ai.managed.customProfileInvalid")}
            </p>
          )}
          {managedConfig.custom_profiles.enabled && (
            <p className="ai-connection-note">{t("ai.managed.addModelsHint")}</p>
          )}
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
              name="connection-name"
              value={connectionDraft.name}
              maxLength={80}
              required
              onChange={(event) => setConnectionDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <UiSelect
              label={t("ai.connection.protocol")}
              name="connection-protocol"
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
              name="connection-endpoint"
              value={connectionDraft.endpoint}
              type="url"
              maxLength={2_048}
              required
              placeholder="https://example.com/v1"
              onChange={(event) => setConnectionDraft((current) => ({ ...current, endpoint: event.target.value }))}
            />
            <UiInput
              label={t("ai.connection.model")}
              name="connection-model"
              value={connectionDraft.model}
              maxLength={256}
              required
              onChange={(event) => setConnectionDraft((current) => ({ ...current, model: event.target.value }))}
            />
            <UiCheckbox
              label={t("ai.connection.reasoningCapability")}
              name="connection-reasoning"
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
              name="connection-request-overrides"
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
                name="connection-context-window"
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
                name="connection-max-output-tokens"
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
              <UiButton type="submit" variant="primary" data-action="save-connection">
                {t("common.save")}
              </UiButton>
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
