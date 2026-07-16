import { describe, expect, it } from "vitest";
import { parseAiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";

describe("AI Runtime server policy", () => {
  it("accepts user-defined and strict managed policies", () => {
    expect(parseAiRuntimeServerPolicy({ kind: "user_defined" })).toEqual({
      kind: "user_defined"
    });
    expect(parseAiRuntimeServerPolicy({
      kind: "managed_catalog",
      provider: {
        id: "managed-provider",
        label: { en: "Managed provider", "zh-CN": "托管提供方" },
        credentialLabel: { en: "API key", "zh-CN": "API 密钥" },
        protocol: "openai-completions",
        baseUrl: "https://models.example.test/v1/",
        catalog: "openai-models"
      },
      defaultModelProfileId: "model-one",
      modelProfiles: [{
        id: "model-one",
        model: "vendor/model-one",
        label: { en: "Model one", "zh-CN": "模型一" },
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: {}
      }]
    })?.kind).toBe("managed_catalog");
  });

  it("rejects unsafe endpoints and invalid model catalogs", () => {
    expect(parseAiRuntimeServerPolicy({
      kind: "managed_catalog",
      provider: {
        id: "managed-provider",
        label: { en: "Managed provider", "zh-CN": "托管提供方" },
        credentialLabel: { en: "API key", "zh-CN": "API 密钥" },
        protocol: "openai-completions",
        baseUrl: "http://models.example.test/v1/",
        catalog: "openai-models"
      },
      defaultModelProfileId: "model-one",
      modelProfiles: []
    })).toBeNull();
  });
});
