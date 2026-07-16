import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiHostToRuntimeMessage,
  type AiHostToRuntimeMessage,
  type AiRuntimeBootstrapInit,
  type AiRuntimeError,
  type AiRuntimeLocale,
  type AiRuntimeTokenUsage,
  type AiRuntimeToHostMessage
} from "@/features/ai/protocol";
import type { NormalizedAiEndpoint } from "@/features/ai/runtimePolicy";
import type {
  AiRuntimeManagedModelProfile,
  AiRuntimeServerPolicy
} from "@/features/ai/runtimeConfig";
import { hasAiProviderRequestOverrides } from "@/features/ai/providerRequest";
import {
  discoverManagedModelProfiles,
  ManagedCatalogError
} from "@/ai-runtime/managedCatalog";
import type { AiWorkspaceContextSnapshot } from "@/features/ai/toolContract";
import {
  AiAgentSession,
  type AiAgentContentEvent
} from "@/ai-runtime/agentSession";
import { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";
import {
  createAiRuntimeTools,
  prepareAiRuntimeToolResources
} from "@/ai-runtime/runtimeTools";
import {
  aiRuntimeMessages,
  aiSystemPrompt,
  type AiRuntimeStatusMessage
} from "@/ai-runtime/i18n";

const MAX_DELTA_LENGTH = 4_096;
type EndpointConnection = Extract<AiRuntimeBootstrapInit["connection"], { kind: "endpoint" }>;
type ManagedPolicy = Extract<AiRuntimeServerPolicy, { kind: "managed_catalog" }>;

export async function prepareRuntimeResources(
  workspace: AiRuntimeBootstrapInit["workspace"]
) {
  await prepareAiRuntimeToolResources(workspace);
}

let runtimeRoot: HTMLElement | null = null;
let runtimeLabel: HTMLElement | null = null;
let runtimeStatus: HTMLElement | null = null;
let runtimeLocale: AiRuntimeLocale = "en";
let runtimeStatusMessage: AiRuntimeStatusMessage = "handshaking";
let credentialSurface: {
  container: HTMLDivElement;
  destinationLabel: HTMLElement;
  protocolLabel: HTMLElement;
  modelLabel: HTMLElement;
  tokenBudgetLabel: HTMLElement;
  reasoningLabel: HTMLElement;
  reasoningValue: HTMLElement;
  reasoning: boolean;
  requestOverridesLabel: HTMLElement;
  requestOverridesValue: HTMLElement;
  requestOverridesConfigured: boolean;
  credentialLabel: HTMLElement;
  credentialLabelText: { en: string; "zh-CN": string } | null;
  hint: HTMLElement;
  hintText: { en: string; "zh-CN": string } | null;
  submit: HTMLButtonElement;
} | null = null;
let managedControlSurface: {
  container: HTMLDivElement;
  primary: HTMLButtonElement;
  refresh: HTMLButtonElement;
  replace: HTMLButtonElement;
  clear: HTMLButtonElement;
  failed: boolean;
} | null = null;

function renderRuntimeSurface() {
  const messages = aiRuntimeMessages(runtimeLocale);
  document.documentElement.lang = runtimeLocale;
  if (runtimeLabel) runtimeLabel.textContent = messages.label;
  if (runtimeStatus) runtimeStatus.textContent = messages.status[runtimeStatusMessage];
  if (credentialSurface) {
    credentialSurface.container.setAttribute("aria-label", messages.credential.formLabel);
    credentialSurface.destinationLabel.textContent = messages.credential.destinationLabel;
    credentialSurface.protocolLabel.textContent = messages.credential.protocolLabel;
    credentialSurface.modelLabel.textContent = messages.credential.modelLabel;
    credentialSurface.tokenBudgetLabel.textContent = messages.credential.tokenBudgetLabel;
    credentialSurface.reasoningLabel.textContent = messages.credential.reasoningLabel;
    credentialSurface.reasoningValue.textContent = credentialSurface.reasoning
      ? messages.credential.reasoningDeclared
      : messages.credential.reasoningNotDeclared;
    credentialSurface.requestOverridesLabel.textContent = messages.credential.requestOverridesLabel;
    credentialSurface.requestOverridesValue.textContent = credentialSurface.requestOverridesConfigured
      ? messages.credential.requestOverridesConfigured
      : messages.credential.requestOverridesDefault;
    credentialSurface.credentialLabel.textContent = credentialSurface.credentialLabelText
      ? credentialSurface.credentialLabelText[runtimeLocale]
      : messages.credential.inputLabel;
    credentialSurface.hint.textContent = credentialSurface.hintText
      ? credentialSurface.hintText[runtimeLocale]
      : messages.credential.inputHint;
    credentialSurface.submit.textContent = messages.credential.activate;
  }
  if (managedControlSurface) {
    managedControlSurface.primary.textContent = messages.managed.retry;
    managedControlSurface.refresh.textContent = messages.managed.refresh;
    managedControlSurface.replace.textContent = messages.managed.replaceCredential;
    managedControlSurface.clear.textContent = messages.managed.clearCredential;
    managedControlSurface.primary.hidden = !managedControlSurface.failed;
    managedControlSurface.refresh.hidden = managedControlSurface.failed;
  }
}

function setRuntimeStatus(message: AiRuntimeStatusMessage) {
  runtimeStatusMessage = message;
  renderRuntimeSurface();
}

function setRuntimeLocale(locale: AiRuntimeLocale) {
  runtimeLocale = locale;
  renderRuntimeSurface();
}

export function prepareRuntimeSurface(nonce: string, locale: AiRuntimeLocale) {
  const style = document.createElement("style");
  style.nonce = nonce;
  style.textContent = `
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; --runtime-text: #252a34; --runtime-border: #d7dce3; --runtime-canvas: #ffffff; --runtime-control: #f5f7f9; }
    body { margin: 0; min-width: 0; background: transparent; color: var(--runtime-text); }
    #ai-runtime-root { box-sizing: border-box; display: grid; gap: 7px; padding: 10px 12px; }
    .runtime-label { margin: 0; font-size: 12px; font-weight: 650; }
    .runtime-status, .credential-hint { margin: 0; font-size: 11px; opacity: 0.72; line-height: 1.35; }
    .credential-form { display: grid; gap: 8px; padding-top: 4px; border-top: 1px solid var(--runtime-border); }
    .connection-details { display: grid; gap: 4px; margin: 0; }
    .connection-details div { display: grid; grid-template-columns: minmax(92px, auto) minmax(0, 1fr); gap: 8px; }
    .connection-details dt { font-size: 10px; opacity: 0.68; }
    .connection-details dd { min-width: 0; margin: 0; font-size: 10px; overflow-wrap: anywhere; }
    .credential-field { display: grid; gap: 4px; font-size: 11px; }
    .credential-field input { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 7px; border: 1px solid var(--runtime-border); border-radius: 4px; background: var(--runtime-canvas); color: var(--runtime-text); }
    .credential-form button { justify-self: end; padding: 6px 10px; border: 1px solid var(--runtime-border); border-radius: 4px; background: var(--runtime-control); color: var(--runtime-text); font: inherit; cursor: pointer; }
    .managed-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; padding-top: 4px; border-top: 1px solid var(--runtime-border); }
    .managed-controls button { padding: 5px 8px; border: 1px solid var(--runtime-border); border-radius: 4px; background: var(--runtime-control); color: var(--runtime-text); font: inherit; cursor: pointer; }
  `;
  document.head.append(style);

  runtimeRoot = document.getElementById("ai-runtime-root");
  if (!runtimeRoot) throw new Error("ai_runtime_root_missing");
  runtimeRoot.replaceChildren();
  runtimeLabel = document.createElement("p");
  runtimeLabel.className = "runtime-label";
  runtimeStatus = document.createElement("p");
  runtimeStatus.className = "runtime-status";
  runtimeRoot.append(runtimeLabel, runtimeStatus);
  setRuntimeLocale(locale);
}

function removeRuntimeControls() {
  credentialSurface?.container.remove();
  credentialSurface = null;
  managedControlSurface?.container.remove();
  managedControlSurface = null;
}

function renderManagedControlSurface(
  failed: boolean,
  actions: {
    retry: () => void;
    refresh: () => void;
    replace: () => void;
    clear: () => void;
  }
) {
  if (!runtimeRoot) return;
  removeRuntimeControls();
  const container = document.createElement("div");
  container.className = "managed-controls";
  const button = (action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.addEventListener("click", action);
    container.append(element);
    return element;
  };
  const primary = button(actions.retry);
  const refresh = button(actions.refresh);
  const replace = button(actions.replace);
  const clear = button(actions.clear);
  managedControlSurface = { container, primary, refresh, replace, clear, failed };
  runtimeRoot.append(container);
  renderRuntimeSurface();
}

function renderCredentialSurface(
  connection: EndpointConnection,
  onActivate: (credential: string) => void,
  text?: {
    label: { en: string; "zh-CN": string };
    hint: { en: string; "zh-CN": string };
  }
) {
  if (!runtimeRoot) return;
  removeRuntimeControls();
  const container = document.createElement("div");
  container.className = "credential-form";
  container.setAttribute("role", "group");
  const details = document.createElement("dl");
  details.className = "connection-details";
  const detail = (value: string) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    description.textContent = value;
    row.append(term, description);
    details.append(row);
    return { label: term, value: description };
  };
  const destination = detail(connection.baseUrl);
  const protocol = detail(connection.protocol);
  const model = detail(connection.model);
  const tokenBudget = detail(
    `${connection.contextWindow.toLocaleString(runtimeLocale)} / ${
      connection.maxOutputTokens.toLocaleString(runtimeLocale)
    }`
  );
  const reasoning = detail(
    connection.reasoning
      ? aiRuntimeMessages(runtimeLocale).credential.reasoningDeclared
      : aiRuntimeMessages(runtimeLocale).credential.reasoningNotDeclared
  );
  const requestOverridesConfigured = hasAiProviderRequestOverrides(connection.requestOverrides);
  const requestOverrides = detail(requestOverridesConfigured
    ? aiRuntimeMessages(runtimeLocale).credential.requestOverridesConfigured
    : aiRuntimeMessages(runtimeLocale).credential.requestOverridesDefault);
  const field = document.createElement("label");
  field.className = "credential-field";
  const credentialLabel = document.createElement("span");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("data-1p-ignore", "true");
  input.setAttribute("data-lpignore", "true");
  field.append(credentialLabel, input);
  const hint = document.createElement("p");
  hint.className = "credential-hint";
  const submit = document.createElement("button");
  submit.type = "button";
  container.append(details, field, hint, submit);
  let activated = false;
  const activate = () => {
    if (activated) return;
    activated = true;
    const credential = input.value;
    input.value = "";
    credentialSurface = null;
    container.remove();
    onActivate(credential);
  };
  submit.addEventListener("click", activate, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    activate();
  });
  credentialSurface = {
    container,
    destinationLabel: destination.label,
    protocolLabel: protocol.label,
    modelLabel: model.label,
    tokenBudgetLabel: tokenBudget.label,
    reasoningLabel: reasoning.label,
    reasoningValue: reasoning.value,
    reasoning: connection.reasoning,
    requestOverridesLabel: requestOverrides.label,
    requestOverridesValue: requestOverrides.value,
    requestOverridesConfigured,
    credentialLabel,
    credentialLabelText: text?.label ?? null,
    hint,
    hintText: text?.hint ?? null,
    submit
  };
  runtimeRoot.append(container);
  renderRuntimeSurface();
  input.focus();
}

function post(port: MessagePort, message: AiRuntimeToHostMessage) {
  port.postMessage(message);
}

function managedEndpointConnection(
  policy: ManagedPolicy,
  profile: AiRuntimeManagedModelProfile
): EndpointConnection {
  return {
    kind: "endpoint",
    connectionId: `${policy.provider.id}:${profile.id}`,
    protocol: policy.provider.protocol,
    baseUrl: policy.provider.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
    reasoning: profile.reasoning,
    requestOverrides: profile.requestOverrides
  };
}

function postContent(
  port: MessagePort,
  sessionId: string,
  turnId: string,
  event: AiAgentContentEvent
) {
  if (event.type === "start") {
    post(port, {
      type: "toss.ai.runtime.content_start",
      sessionId,
      turnId,
      blockId: event.blockId,
      kind: event.kind
    });
    return;
  }
  if (event.type === "end") {
    post(port, {
      type: "toss.ai.runtime.content_end",
      sessionId,
      turnId,
      blockId: event.blockId
    });
    return;
  }
  for (let offset = 0; offset < event.delta.length; offset += MAX_DELTA_LENGTH) {
    post(port, {
      type: "toss.ai.runtime.content_delta",
      sessionId,
      turnId,
      blockId: event.blockId,
      delta: event.delta.slice(offset, offset + MAX_DELTA_LENGTH)
    });
  }
}

export function startRuntime(
  port: MessagePort,
  init: AiRuntimeBootstrapInit,
  policy: AiRuntimeServerPolicy,
  endpoint: NormalizedAiEndpoint | null,
  providerStream: StreamFn | null
) {
  let activeTurnId: string | null = null;
  let timers: number[] = [];
  let agentSession: AiAgentSession | null = null;
  let credential: string | null = null;
  let credentialEpoch = 0;
  let availableModelProfileIds: string[] = [];
  let selectedModelProfileId = init.connection.kind === "managed"
    ? init.connection.modelProfileId
    : null;
  let preferences = { ...init.preferences };
  let currentWorkspaceContext: AiWorkspaceContextSnapshot | null = null;
  let currentConversation = init.conversation;
  const toolBridge = new AiRuntimeToolBridge(port, init.sessionId, () => runtimeLocale);
  let runtimeTools = createAiRuntimeTools(init.workspace, toolBridge, runtimeLocale);

  const clearTimers = () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  };

  const fail = (code: string, message: string, turnId?: string) => {
    const error: AiRuntimeError = {
      type: "toss.ai.runtime.error",
      sessionId: init.sessionId,
      ...(turnId ? { turnId } : {}),
      code,
      message
    };
    post(port, error);
  };

  const postConnectionState = (
    state: "credential_required" | "discovering_models" | "model_required" | "ready"
  ) => {
    post(port, {
      type: "toss.ai.runtime.connection_state",
      sessionId: init.sessionId,
      state
    });
  };

  const postUsage = (turnId: string, usage: AiRuntimeTokenUsage) => {
    post(port, {
      type: "toss.ai.runtime.usage",
      sessionId: init.sessionId,
      turnId,
      ...usage
    });
  };

  const postManagedCatalog = (errorCode?: string) => {
    post(port, {
      type: "toss.ai.runtime.managed_catalog",
      sessionId: init.sessionId,
      availableModelProfileIds: [...availableModelProfileIds],
      ...(selectedModelProfileId ? { selectedModelProfileId } : {}),
      ...(errorCode ? { errorCode } : {})
    });
  };

  const createAgentSession = (
    connection: EndpointConnection,
    activeCredential: string
  ) => {
    agentSession?.dispose();
    agentSession = new AiAgentSession({
      connection,
      credential: activeCredential,
      conversationId: currentConversation.conversationId,
      history: currentConversation.history,
      stream: providerStream!,
      systemPrompt: aiSystemPrompt(runtimeLocale, init.workspace, currentWorkspaceContext),
      tools: runtimeTools,
      preferences,
      onContent: (turnId, event) => {
        if (activeTurnId !== turnId) return;
        if (event.type === "delta") setRuntimeStatus("streamingConnection");
        postContent(port, init.sessionId, turnId, event);
      },
      onUsage: (turnId, usage) => {
        if (activeTurnId !== turnId) return;
        postUsage(turnId, usage);
      }
    });
  };

  const complete = (turnId: string, outcome: "completed" | "cancelled") => {
    activeTurnId = null;
    setRuntimeStatus(outcome === "cancelled" ? "readyAfterCancellation" : (
      init.connection.kind === "fake" ? "readyFake" : "readyConnection"
    ));
    post(port, {
      type: "toss.ai.runtime.turn_complete",
      sessionId: init.sessionId,
      turnId,
      outcome
    });
  };

  const managedPolicy = policy.kind === "managed_catalog" ? policy : null;

  function managedProfile(profileId: string | null) {
    if (!managedPolicy || !profileId) return null;
    return managedPolicy.modelProfiles.find((profile) => profile.id === profileId) ?? null;
  }

  function requestManagedCredential() {
    if (!managedPolicy) return;
    agentSession?.dispose();
    agentSession = null;
    const profile = managedProfile(selectedModelProfileId) ??
      managedProfile(managedPolicy.defaultModelProfileId) ??
      managedPolicy.modelProfiles[0];
    setRuntimeStatus("credentialRequired");
    postConnectionState("credential_required");
    renderCredentialSurface(
      managedEndpointConnection(managedPolicy, profile),
      (value) => {
        if (!value) {
          requestManagedCredential();
          return;
        }
        credential = value;
        credentialEpoch += 1;
        void refreshManagedCatalog();
      },
      {
        label: managedPolicy.provider.credentialLabel,
        hint: {
          en: aiRuntimeMessages("en").managed.credentialHint,
          "zh-CN": aiRuntimeMessages("zh-CN").managed.credentialHint
        }
      }
    );
  }

  function clearManagedCredential() {
    if (activeTurnId) {
      fail("runtime_credential_change_during_turn", aiRuntimeMessages(runtimeLocale).errors.turnInProgress);
      return;
    }
    credentialEpoch += 1;
    credential = null;
    availableModelProfileIds = [];
    agentSession?.dispose();
    agentSession = null;
    postManagedCatalog();
    requestManagedCredential();
  }

  function activateManagedProfile(profileId: string) {
    if (
      !managedPolicy ||
      !credential ||
      !availableModelProfileIds.includes(profileId)
    ) return false;
    const profile = managedProfile(profileId);
    if (!profile) return false;
    try {
      selectedModelProfileId = profile.id;
      createAgentSession(
        managedEndpointConnection(managedPolicy, profile),
        credential
      );
      setRuntimeStatus("readyConnection");
      postManagedCatalog();
      postConnectionState("ready");
      renderManagedControlSurface(false, {
        retry: () => void refreshManagedCatalog(),
        refresh: () => void refreshManagedCatalog(),
        replace: clearManagedCredential,
        clear: clearManagedCredential
      });
      return true;
    } catch {
      agentSession = null;
      setRuntimeStatus("providerFailed");
      fail(
        "runtime_provider_initialization_failed",
        aiRuntimeMessages(runtimeLocale).errors.providerFailed
      );
      return false;
    }
  }

  async function refreshManagedCatalog() {
    if (activeTurnId) {
      fail("runtime_catalog_refresh_during_turn", aiRuntimeMessages(runtimeLocale).errors.turnInProgress);
      return;
    }
    if (!managedPolicy || !credential) {
      requestManagedCredential();
      return;
    }
    const requestEpoch = credentialEpoch;
    const activeCredential = credential;
    agentSession?.dispose();
    agentSession = null;
    setRuntimeStatus("discoveringModels");
    postConnectionState("discovering_models");
    removeRuntimeControls();
    try {
      const discovered = await discoverManagedModelProfiles(
        managedPolicy,
        activeCredential,
        preferences
      );
      if (requestEpoch !== credentialEpoch || credential !== activeCredential) return;
      availableModelProfileIds = discovered;
      const nextProfileId = [
        selectedModelProfileId,
        managedPolicy.defaultModelProfileId,
        ...availableModelProfileIds
      ].find((profileId): profileId is string => (
        !!profileId && availableModelProfileIds.includes(profileId)
      )) ?? null;
      selectedModelProfileId = nextProfileId;
      if (nextProfileId && activateManagedProfile(nextProfileId)) return;
      postManagedCatalog();
      setRuntimeStatus("modelRequired");
      postConnectionState("model_required");
      renderManagedControlSurface(false, {
        retry: () => void refreshManagedCatalog(),
        refresh: () => void refreshManagedCatalog(),
        replace: clearManagedCredential,
        clear: clearManagedCredential
      });
    } catch (error) {
      if (requestEpoch !== credentialEpoch || credential !== activeCredential) return;
      availableModelProfileIds = [];
      const code = error instanceof ManagedCatalogError
        ? error.code
        : "managed_catalog_request_failed";
      postManagedCatalog(code);
      if (code === "managed_catalog_auth_rejected") {
        credentialEpoch += 1;
        credential = null;
        requestManagedCredential();
        return;
      }
      setRuntimeStatus("catalogFailed");
      postConnectionState("model_required");
      renderManagedControlSurface(true, {
        retry: () => void refreshManagedCatalog(),
        refresh: () => void refreshManagedCatalog(),
        replace: clearManagedCredential,
        clear: clearManagedCredential
      });
    }
  }

  const startFakeTurn = (turnId: string) => {
    if (activeTurnId) {
      fail("runtime_turn_in_progress", aiRuntimeMessages(runtimeLocale).errors.turnInProgress, turnId);
      return;
    }
    activeTurnId = turnId;
    setRuntimeStatus("runningFake");
    const fakeResponse = aiRuntimeMessages(runtimeLocale).fakeResponse;
    postContent(port, init.sessionId, turnId, {
      type: "start",
      blockId: "content-0-0",
      kind: "text"
    });
    fakeResponse.forEach((text, index) => {
      timers.push(window.setTimeout(() => {
        if (activeTurnId !== turnId) return;
        setRuntimeStatus("streamingFake");
        postContent(port, init.sessionId, turnId, {
          type: "delta",
          blockId: "content-0-0",
          delta: text
        });
        if (index === fakeResponse.length - 1) {
          postContent(port, init.sessionId, turnId, {
            type: "end",
            blockId: "content-0-0"
          });
          complete(turnId, "completed");
        }
      }, 40 * (index + 1)));
    });
  };

  const startProviderTurn = async (
    conversationId: string,
    turnId: string,
    prompt: string,
    workspace: AiWorkspaceContextSnapshot | null
  ) => {
    if (activeTurnId) {
      fail("runtime_turn_in_progress", aiRuntimeMessages(runtimeLocale).errors.turnInProgress, turnId);
      return;
    }
    if (!agentSession) {
      fail("runtime_connection_required", aiRuntimeMessages(runtimeLocale).errors.notConfigured, turnId);
      return;
    }
    if (conversationId !== currentConversation.conversationId) {
      fail("runtime_conversation_mismatch", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage, turnId);
      return;
    }
    if (
      (init.workspace === null) !== (workspace === null) ||
      (init.workspace && workspace && (
        init.workspace.project_type !== workspace.project_type ||
        init.workspace.mode !== workspace.mode
      ))
    ) {
      fail("runtime_workspace_context_mismatch", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage, turnId);
      return;
    }
    currentWorkspaceContext = workspace;
    agentSession.setSystemPrompt(aiSystemPrompt(
      runtimeLocale,
      init.workspace,
      currentWorkspaceContext
    ));
    activeTurnId = turnId;
    setRuntimeStatus("runningConnection");
    try {
      toolBridge.beginTurn(turnId);
    } catch {
      activeTurnId = null;
      fail("runtime_tool_bridge_unavailable", aiRuntimeMessages(runtimeLocale).errors.providerFailed, turnId);
      return;
    }
    const outcome = await agentSession.prompt(turnId, prompt);
    toolBridge.endTurn(turnId);
    if (activeTurnId !== turnId) return;
    if (outcome.outcome === "failed") {
      activeTurnId = null;
      setRuntimeStatus("providerFailed");
      const errors = aiRuntimeMessages(runtimeLocale).errors;
      const message = outcome.code === "ai_agent_context_budget_exceeded"
        ? errors.contextBudgetExceeded
        : outcome.code === "ai_agent_provider_call_budget_exceeded"
          ? errors.providerCallBudgetExceeded
          : outcome.code === "ai_agent_turn_timeout"
            ? errors.turnTimeout
            : errors.providerFailed;
      fail(outcome.code, message, turnId);
      return;
    }
    complete(turnId, outcome.outcome === "cancelled" ? "cancelled" : "completed");
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (!isAiHostToRuntimeMessage(event.data)) {
      setRuntimeStatus("invalidHostMessage");
      fail("runtime_message_invalid", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage);
      return;
    }
    const message: AiHostToRuntimeMessage = event.data;
    if (message.sessionId !== init.sessionId) return;
    if (message.type === "toss.ai.host.tool_result") {
      if (!toolBridge.handleResult(message)) {
        setRuntimeStatus("invalidHostMessage");
        fail("runtime_tool_result_invalid", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage);
      }
      return;
    }
    if (message.type === "toss.ai.host.set_locale") {
      setRuntimeLocale(message.locale);
      runtimeTools = createAiRuntimeTools(init.workspace, toolBridge, runtimeLocale);
      agentSession?.setSystemPrompt(aiSystemPrompt(
        runtimeLocale,
        init.workspace,
        currentWorkspaceContext
      ));
      agentSession?.setTools(runtimeTools);
      return;
    }
    if (message.type === "toss.ai.host.set_preferences") {
      if (activeTurnId) {
        fail("runtime_preferences_change_during_turn", aiRuntimeMessages(runtimeLocale).errors.turnInProgress);
        return;
      }
      try {
        preferences = { ...message.preferences };
        agentSession?.setPreferences(preferences);
      } catch {
        fail("runtime_preferences_change_failed", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage);
      }
      return;
    }
    if (message.type === "toss.ai.host.select_managed_model") {
      if (activeTurnId) {
        fail("runtime_model_change_during_turn", aiRuntimeMessages(runtimeLocale).errors.turnInProgress);
        return;
      }
      if (
        message.conversation.conversationId !== currentConversation.conversationId
      ) {
        fail("runtime_conversation_mismatch", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage);
        return;
      }
      currentConversation = message.conversation;
      if (!managedPolicy || !activateManagedProfile(message.modelProfileId)) {
        fail("runtime_managed_model_unavailable", aiRuntimeMessages(runtimeLocale).errors.notConfigured);
      }
      return;
    }
    if (message.type === "toss.ai.host.set_conversation") {
      if (activeTurnId) {
        fail("runtime_conversation_switch_during_turn", aiRuntimeMessages(runtimeLocale).errors.turnInProgress);
        return;
      }
      try {
        agentSession?.setConversation(
          message.conversation.conversationId,
          message.conversation.history
        );
        currentConversation = message.conversation;
        setRuntimeStatus(
          init.connection.kind === "fake"
            ? "readyFake"
            : agentSession
              ? "readyConnection"
              : "credentialRequired"
        );
      } catch {
        fail("runtime_conversation_switch_failed", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage);
      }
      return;
    }
    if (message.type === "toss.ai.host.start_turn") {
      if (message.conversationId !== currentConversation.conversationId) {
        fail("runtime_conversation_mismatch", aiRuntimeMessages(runtimeLocale).errors.invalidHostMessage, message.turnId);
      } else if (init.connection.kind === "fake") {
        startFakeTurn(message.turnId);
      } else {
        void startProviderTurn(
          message.conversationId,
          message.turnId,
          message.prompt,
          message.workspace
        );
      }
      return;
    }
    if (message.type === "toss.ai.host.cancel_turn") {
      if (activeTurnId !== message.turnId) return;
      if (init.connection.kind === "fake") {
        clearTimers();
        complete(message.turnId, "cancelled");
      } else {
        agentSession?.cancel(message.turnId);
        toolBridge.cancelTurn(message.turnId);
      }
      return;
    }
    clearTimers();
    activeTurnId = null;
    agentSession?.dispose();
    agentSession = null;
    toolBridge.dispose();
    removeRuntimeControls();
    port.removeEventListener("message", handleMessage);
    port.close();
  };

  port.addEventListener("message", handleMessage);
  port.start();
  post(port, {
    type: "toss.ai.runtime.ready",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: init.sessionId,
    nonce: init.nonce
  });

  if (init.connection.kind === "fake") {
    setRuntimeStatus("readyFake");
    postConnectionState("ready");
    return;
  }
  const connection = init.connection;
  if (connection.kind === "managed") {
    if (!managedPolicy || !endpoint || !providerStream) {
      setRuntimeStatus("providerFailed");
      fail("runtime_managed_provider_unavailable", aiRuntimeMessages(runtimeLocale).errors.providerFailed);
      return;
    }
    if (!managedProfile(selectedModelProfileId)) {
      selectedModelProfileId = managedPolicy.defaultModelProfileId;
    }
    requestManagedCredential();
    return;
  }
  if (connection.kind !== "endpoint" || !endpoint || !providerStream) {
    setRuntimeStatus("providerFailed");
    fail("runtime_provider_unavailable", aiRuntimeMessages(runtimeLocale).errors.providerFailed);
    return;
  }
  setRuntimeStatus("credentialRequired");
  postConnectionState("credential_required");
  renderCredentialSurface(connection, (credential) => {
    try {
      createAgentSession(connection, credential);
      setRuntimeStatus("readyConnection");
      postConnectionState("ready");
    } catch {
      agentSession = null;
      setRuntimeStatus("providerFailed");
      fail("runtime_provider_initialization_failed", aiRuntimeMessages(runtimeLocale).errors.providerFailed);
    }
  });
}
