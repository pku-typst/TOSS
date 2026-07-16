import type { AuthConfig } from "@/lib/api/types";
import {
  AI_RUNTIME_MODEL_TOKEN_LIMITS,
  isAiRuntimeModelTokenBudget,
  type AiRuntimeManagedCatalogModel,
  type AiRuntimeManagedCustomModelProfile,
  type AiRuntimeManagedModelSelection
} from "@/features/ai/protocol";
import {
  isAiProviderRequestOverrides,
  type AiProviderRequestOverrides
} from "@/features/ai/providerRequest";
import type { AiAccountSettings } from "@/features/ai/accountSettingsStore";

type ManagedConfig = Extract<
  NonNullable<AuthConfig["ai_assistant"]>,
  { kind: "managed_catalog" }
>;

export function secureManagedCustomProfileId() {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return `custom-${Array.from(
    bytes,
    (value) => value.toString(16).padStart(2, "0")
  ).join("")}`;
}

export function requestedManagedSelection(
  config: ManagedConfig,
  settings: AiAccountSettings
): AiRuntimeManagedModelSelection {
  const selection = settings.managedModelSelection;
  if (
    selection?.kind === "recommended" &&
    config.model_profiles.some((profile) => profile.id === selection.profileId)
  ) return selection;
  if (selection?.kind === "custom" && config.custom_profiles.enabled) {
    const profile = managedCustomProfilesForConfig(config, settings).find(
      (candidate) => candidate.profileId === selection.profileId
    );
    if (profile) return { kind: "custom", ...profile };
  }
  return { kind: "recommended", profileId: config.default_model_profile };
}

export function managedCustomProfilesForConfig(
  config: ManagedConfig,
  settings: AiAccountSettings
) {
  if (!config.custom_profiles.enabled) return [];
  return (settings.managedCustomProfiles ?? [])
    .filter((profile) => isManagedCustomProfileWithinPolicy(config, profile))
    .slice(0, config.custom_profiles.max_saved_profiles);
}

export function createManagedCustomProfile(
  config: ManagedConfig,
  model: AiRuntimeManagedCatalogModel
): AiRuntimeManagedCustomModelProfile | null {
  if (!config.custom_profiles.enabled) return null;
  const { defaults, limits } = config.custom_profiles;
  const providerContextCap = model.maxInputTokens ?? limits.max_context_window;
  const providerOutputCap = model.maxOutputTokens ?? limits.max_output_tokens;
  const maxContext = Math.min(limits.max_context_window, providerContextCap);
  const maxOutput = Math.min(limits.max_output_tokens, providerOutputCap);
  if (
    maxContext < limits.min_context_window ||
    maxOutput < limits.min_output_tokens
  ) return null;
  let contextWindow = Math.min(Math.max(
    defaults.context_window,
    limits.min_context_window
  ), maxContext);
  let maxOutputTokens = Math.min(Math.max(
    defaults.max_output_tokens,
    limits.min_output_tokens
  ), maxOutput);
  const requiredContext = maxOutputTokens +
    AI_RUNTIME_MODEL_TOKEN_LIMITS.contextSafetyTokens +
    AI_RUNTIME_MODEL_TOKEN_LIMITS.minInputTokens;
  if (contextWindow < requiredContext) {
    contextWindow = Math.min(maxContext, requiredContext);
  }
  if (!isAiRuntimeModelTokenBudget(contextWindow, maxOutputTokens)) {
    maxOutputTokens = Math.min(
      maxOutputTokens,
      contextWindow - AI_RUNTIME_MODEL_TOKEN_LIMITS.contextSafetyTokens -
        AI_RUNTIME_MODEL_TOKEN_LIMITS.minInputTokens
    );
  }
  if (
    maxOutputTokens < limits.min_output_tokens ||
    !isAiRuntimeModelTokenBudget(contextWindow, maxOutputTokens)
  ) return null;
  const requestOverrides = isAiProviderRequestOverrides(defaults.request_overrides)
    ? defaults.request_overrides as AiProviderRequestOverrides
    : {};
  return {
    profileId: secureManagedCustomProfileId(),
    model: model.id,
    contextWindow,
    maxOutputTokens,
    reasoning: defaults.reasoning,
    requestOverrides
  };
}

export function isManagedCustomProfileWithinPolicy(
  config: ManagedConfig,
  profile: AiRuntimeManagedCustomModelProfile
) {
  const { limits } = config.custom_profiles;
  return config.custom_profiles.enabled &&
    profile.contextWindow >= limits.min_context_window &&
    profile.contextWindow <= limits.max_context_window &&
    profile.maxOutputTokens >= limits.min_output_tokens &&
    profile.maxOutputTokens <= limits.max_output_tokens &&
    isAiRuntimeModelTokenBudget(profile.contextWindow, profile.maxOutputTokens) &&
    isAiProviderRequestOverrides(profile.requestOverrides);
}
