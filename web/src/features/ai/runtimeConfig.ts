import { BUILD_AI_CONNECTION_POLICY } from "@/features/ai/buildPolicy";
import {
  isAiRuntimeModelTokenBudget,
  type AiRuntimeProviderProtocol
} from "@/features/ai/protocol";
import {
  isAiProviderRequestOverrides,
  type AiProviderRequestOverrides
} from "@/features/ai/providerRequest";

export type AiConnectionPolicyKind = "user_defined" | "managed_catalog";

export type AiRuntimeManagedProvider = {
  id: string;
  label: { en: string; "zh-CN": string };
  credentialLabel: { en: string; "zh-CN": string };
  protocol: Extract<AiRuntimeProviderProtocol, "openai-completions">;
  baseUrl: string;
  catalog: "openai-models";
};

export type AiRuntimeManagedModelProfile = {
  id: string;
  model: string;
  label: { en: string; "zh-CN": string };
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  requestOverrides: AiProviderRequestOverrides;
};

export type AiRuntimeManagedCustomProfiles = {
  enabled: boolean;
  requireCatalogMatch: boolean;
  defaults: {
    contextWindow: number;
    maxOutputTokens: number;
    reasoning: boolean;
    requestOverrides: AiProviderRequestOverrides;
  };
  limits: {
    minContextWindow: number;
    maxContextWindow: number;
    minOutputTokens: number;
    maxOutputTokens: number;
  };
  maxSavedProfiles: number;
};

export type AiRuntimeServerPolicy =
  | { kind: "user_defined" }
  | {
      kind: "managed_catalog";
      provider: AiRuntimeManagedProvider;
      defaultModelProfileId: string;
      modelProfiles: AiRuntimeManagedModelProfile[];
      customProfiles: AiRuntimeManagedCustomProfiles;
    };

const MAX_POLICY_BYTES = 256 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isLocalizedText(value: unknown): value is { en: string; "zh-CN": string } {
  return isRecord(value) &&
    hasExactKeys(value, ["en", "zh-CN"]) &&
    typeof value.en === "string" && value.en.length > 0 && value.en.length <= 400 &&
    typeof value["zh-CN"] === "string" && value["zh-CN"].length > 0 &&
    value["zh-CN"].length <= 400;
}

function isManagedProvider(value: unknown): value is AiRuntimeManagedProvider {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "label",
    "credentialLabel",
    "protocol",
    "baseUrl",
    "catalog"
  ])) return false;
  if (
    typeof value.id !== "string" || value.id.length > 64 || !SLUG.test(value.id) ||
    !isLocalizedText(value.label) || !isLocalizedText(value.credentialLabel) ||
    value.protocol !== "openai-completions" || value.catalog !== "openai-models" ||
    typeof value.baseUrl !== "string" || value.baseUrl.length > 2_048
  ) return false;
  try {
    const url = new URL(value.baseUrl);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname.endsWith("/");
  } catch {
    return false;
  }
}

function isManagedModelProfile(value: unknown): value is AiRuntimeManagedModelProfile {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "model",
      "label",
      "contextWindow",
      "maxOutputTokens",
      "reasoning",
      "requestOverrides"
    ]) &&
    typeof value.id === "string" && value.id.length <= 64 && SLUG.test(value.id) &&
    typeof value.model === "string" && value.model.length > 0 && value.model.length <= 256 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value.model) &&
    isLocalizedText(value.label) &&
    isAiRuntimeModelTokenBudget(value.contextWindow, value.maxOutputTokens) &&
    typeof value.reasoning === "boolean" &&
    isAiProviderRequestOverrides(value.requestOverrides);
}

function isManagedCustomProfiles(value: unknown): value is AiRuntimeManagedCustomProfiles {
  if (!isRecord(value) || !hasExactKeys(value, [
    "enabled",
    "requireCatalogMatch",
    "defaults",
    "limits",
    "maxSavedProfiles"
  ])) return false;
  const defaults = value.defaults;
  const limits = value.limits;
  if (
    typeof value.enabled !== "boolean" ||
    value.requireCatalogMatch !== true ||
    !Number.isSafeInteger(value.maxSavedProfiles) ||
    Number(value.maxSavedProfiles) < 1 || Number(value.maxSavedProfiles) > 32 ||
    !isRecord(defaults) || !hasExactKeys(defaults, [
      "contextWindow",
      "maxOutputTokens",
      "reasoning",
      "requestOverrides"
    ]) ||
    !isAiRuntimeModelTokenBudget(defaults.contextWindow, defaults.maxOutputTokens) ||
    typeof defaults.reasoning !== "boolean" ||
    !isAiProviderRequestOverrides(defaults.requestOverrides) ||
    !isRecord(limits) || !hasExactKeys(limits, [
      "minContextWindow",
      "maxContextWindow",
      "minOutputTokens",
      "maxOutputTokens"
    ])
  ) return false;
  const values = [
    limits.minContextWindow,
    limits.maxContextWindow,
    limits.minOutputTokens,
    limits.maxOutputTokens
  ];
  if (!values.every(Number.isSafeInteger)) return false;
  return Number(limits.minContextWindow) >= 8_192 &&
    Number(limits.minContextWindow) <= Number(limits.maxContextWindow) &&
    Number(limits.maxContextWindow) <= 4_194_304 &&
    Number(limits.minOutputTokens) >= 256 &&
    Number(limits.minOutputTokens) <= Number(limits.maxOutputTokens) &&
    Number(limits.maxOutputTokens) <= 1_048_576 &&
    Number(defaults.contextWindow) >= Number(limits.minContextWindow) &&
    Number(defaults.contextWindow) <= Number(limits.maxContextWindow) &&
    Number(defaults.maxOutputTokens) >= Number(limits.minOutputTokens) &&
    Number(defaults.maxOutputTokens) <= Number(limits.maxOutputTokens);
}

export function parseAiRuntimeServerPolicy(value: unknown): AiRuntimeServerPolicy | null {
  if (!isRecord(value) || (value.kind !== "user_defined" && value.kind !== "managed_catalog")) {
    return null;
  }
  if (value.kind === "user_defined") {
    return hasExactKeys(value, ["kind"])
      ? value as AiRuntimeServerPolicy
      : null;
  }
  if (
    !hasExactKeys(value, [
      "kind",
      "provider",
      "defaultModelProfileId",
      "modelProfiles",
      "customProfiles"
    ]) ||
    !isManagedProvider(value.provider) ||
    !isManagedCustomProfiles(value.customProfiles) ||
    typeof value.defaultModelProfileId !== "string" ||
    !Array.isArray(value.modelProfiles) ||
    value.modelProfiles.length === 0 || value.modelProfiles.length > 128
  ) return null;
  const ids = new Set<string>();
  const models = new Set<string>();
  for (const profile of value.modelProfiles) {
    if (!isManagedModelProfile(profile) || ids.has(profile.id) || models.has(profile.model)) {
      return null;
    }
    ids.add(profile.id);
    models.add(profile.model);
  }
  if (!ids.has(value.defaultModelProfileId)) return null;
  return value as AiRuntimeServerPolicy;
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_POLICY_BYTES * 2) {
    throw new Error("ai_runtime_policy_encoding_invalid");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = window.atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  if (binary.length > MAX_POLICY_BYTES) throw new Error("ai_runtime_policy_too_large");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0))
  );
}

export function readAiRuntimeServerPolicy(): AiRuntimeServerPolicy {
  const encoded = document.querySelector<HTMLScriptElement>(
    "script[data-toss-ai-bootstrap='true']"
  )?.dataset.tossAiPolicy;
  if (!encoded || encoded === "__TOSS_AI_RUNTIME_POLICY__") {
    throw new Error("ai_runtime_policy_missing");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decodeBase64Url(encoded));
  } catch (error) {
    throw new Error("ai_runtime_policy_invalid", { cause: error });
  }
  const policy = parseAiRuntimeServerPolicy(raw);
  if (!policy || policy.kind !== BUILD_AI_CONNECTION_POLICY) {
    throw new Error("ai_runtime_policy_build_mismatch");
  }
  return policy;
}

export function localizedAiPolicyText(
  value: { en: string; "zh-CN": string },
  locale: "en" | "zh-CN"
) {
  return value[locale];
}
