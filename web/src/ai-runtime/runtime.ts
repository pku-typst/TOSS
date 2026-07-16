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
import runtimeSurfaceCss from "@/ai-runtime/runtimeSurface.css?inline";
import {
  applyRuntimeDesignTheme,
  DEFAULT_RUNTIME_DESIGN_THEME,
  type RuntimeDesignTheme
} from "@/design/runtimeTheme";

const MAX_DELTA_LENGTH = 4_096;
const VISIBLE_SURFACE_STATUSES = new Set<AiRuntimeStatusMessage>([
  "handshaking",
  "discoveringModels",
  "modelRequired",
  "catalogFailed"
]);
type EndpointConnection = Extract<AiRuntimeBootstrapInit["connection"], { kind: "endpoint" }>;
type ManagedPolicy = Extract<AiRuntimeServerPolicy, { kind: "managed_catalog" }>;

export async function prepareRuntimeResources(
  workspace: AiRuntimeBootstrapInit["workspace"]
) {
  await prepareAiRuntimeToolResources(workspace);
}

let runtimeRoot: HTMLElement | null = null;
let runtimeStatus: HTMLElement | null = null;
let runtimeLocale: AiRuntimeLocale = "en";
let runtimeStatusMessage: AiRuntimeStatusMessage = "handshaking";
let credentialSurface: {
  container: HTMLDivElement;
  credentialLabel: HTMLElement;
  credentialLabelText: { en: string; "zh-CN": string } | null;
  hint: HTMLElement;
  hintText: { en: string; "zh-CN": string } | null;
  submit: HTMLButtonElement;
} | null = null;
let managedControlSurface: {
  container: HTMLDivElement;
  action: HTMLButtonElement;
  changeCredential: HTMLButtonElement;
  failed: boolean;
} | null = null;

function renderRuntimeSurface() {
  const messages = aiRuntimeMessages(runtimeLocale);
  document.documentElement.lang = runtimeLocale;
  if (runtimeStatus) {
    runtimeStatus.textContent = messages.status[runtimeStatusMessage];
    runtimeStatus.hidden = credentialSurface !== null ||
      !VISIBLE_SURFACE_STATUSES.has(runtimeStatusMessage);
  }
  if (credentialSurface) {
    credentialSurface.container.setAttribute("aria-label", messages.credential.formLabel);
    credentialSurface.credentialLabel.textContent = credentialSurface.credentialLabelText
      ? credentialSurface.credentialLabelText[runtimeLocale]
      : messages.credential.inputLabel;
    credentialSurface.hint.textContent = credentialSurface.hintText
      ? credentialSurface.hintText[runtimeLocale]
      : messages.credential.inputHint;
    credentialSurface.submit.textContent = messages.credential.connect;
  }
  if (managedControlSurface) {
    managedControlSurface.action.textContent = managedControlSurface.failed
      ? messages.managed.retry
      : messages.managed.refresh;
    managedControlSurface.changeCredential.textContent = messages.managed.changeCredential;
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

export function prepareRuntimeSurface(
  nonce: string,
  locale: AiRuntimeLocale,
  theme: RuntimeDesignTheme = DEFAULT_RUNTIME_DESIGN_THEME
) {
  applyRuntimeDesignTheme(theme);
  const style = document.createElement("style");
  style.nonce = nonce;
  style.textContent = runtimeSurfaceCss;
  document.head.append(style);

  runtimeRoot = document.getElementById("ai-runtime-root");
  if (!runtimeRoot) throw new Error("ai_runtime_root_missing");
  runtimeRoot.replaceChildren();
  runtimeStatus = document.createElement("p");
  runtimeStatus.className = "runtime-status";
  runtimeRoot.append(runtimeStatus);
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
    refresh: () => void;
    changeCredential: () => void;
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
  const action = button(actions.refresh);
  action.dataset.action = "refresh-models";
  const changeCredential = button(actions.changeCredential);
  changeCredential.dataset.action = "change-credential";
  managedControlSurface = { container, action, changeCredential, failed };
  runtimeRoot.append(container);
  renderRuntimeSurface();
}

function renderCredentialSurface(
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
  container.append(field, hint, submit);
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
    setRuntimeStatus("credentialRequired");
    postConnectionState("credential_required");
    renderCredentialSurface(
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

  function changeManagedCredential() {
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
        refresh: () => void refreshManagedCatalog(),
        changeCredential: changeManagedCredential
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
        refresh: () => void refreshManagedCatalog(),
        changeCredential: changeManagedCredential
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
        refresh: () => void refreshManagedCatalog(),
        changeCredential: changeManagedCredential
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
  renderCredentialSurface((credential) => {
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
