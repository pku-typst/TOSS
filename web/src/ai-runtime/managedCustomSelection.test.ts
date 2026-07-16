import { describe, expect, it } from "vitest";
import { isManagedCustomSelectionAvailable } from "@/ai-runtime/managedCustomSelection";
import type { AiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";

const policy: Extract<AiRuntimeServerPolicy, { kind: "managed_catalog" }> = {
  kind: "managed_catalog",
  provider: {
    id: "managed-provider",
    label: { en: "Provider", "zh-CN": "提供方" },
    credentialLabel: { en: "API key", "zh-CN": "API 密钥" },
    protocol: "openai-completions",
    baseUrl: "https://models.example.test/v1/",
    catalog: "openai-models"
  },
  defaultModelProfileId: "recommended-one",
  modelProfiles: [{
    id: "recommended-one",
    model: "vendor/recommended-one",
    label: { en: "Recommended", "zh-CN": "推荐" },
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    reasoning: false,
    requestOverrides: {}
  }],
  customProfiles: {
    enabled: true,
    requireCatalogMatch: true,
    defaults: {
      contextWindow: 65_536,
      maxOutputTokens: 8_192,
      reasoning: false,
      requestOverrides: {}
    },
    limits: {
      minContextWindow: 8_192,
      maxContextWindow: 1_000_000,
      minOutputTokens: 256,
      maxOutputTokens: 128_000
    },
    maxSavedProfiles: 20
  }
};

const selection = {
  kind: "custom" as const,
  profileId: "custom-one",
  model: "vendor/custom-one",
  contextWindow: 65_536,
  maxOutputTokens: 8_192,
  reasoning: true,
  requestOverrides: { reasoning_effort: "high" }
};

describe("managed custom model selection", () => {
  it("requires the live model and enforces its advertised caps", () => {
    expect(isManagedCustomSelectionAvailable(policy, [], selection)).toBe(false);
    expect(isManagedCustomSelectionAvailable(policy, [{
      id: selection.model,
      maxInputTokens: 65_536,
      maxOutputTokens: 8_192
    }], selection)).toBe(true);
    expect(isManagedCustomSelectionAvailable(policy, [{
      id: selection.model,
      maxInputTokens: 32_768,
      maxOutputTokens: 8_192
    }], selection)).toBe(false);
    expect(isManagedCustomSelectionAvailable(policy, [{
      id: selection.model,
      maxInputTokens: 65_536,
      maxOutputTokens: 4_096
    }], selection)).toBe(false);
  });
});
