import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverManagedModelProfiles,
  ManagedCatalogError
} from "@/ai-runtime/managedCatalog";
import type { AiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";
import { DEFAULT_AI_RUNTIME_PREFERENCES } from "@/features/ai/runtimePreferences";

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
  defaultModelProfileId: "model-one",
  modelProfiles: [
    {
      id: "model-one",
      model: "vendor/model-one",
      label: { en: "Model one", "zh-CN": "模型一" },
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      reasoning: false,
      requestOverrides: {}
    },
    {
      id: "model-two",
      model: "vendor/model-two",
      label: { en: "Model two", "zh-CN": "模型二" },
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      reasoning: true,
      requestOverrides: {}
    }
  ]
};

afterEach(() => vi.unstubAllGlobals());

describe("managed model catalog", () => {
  it("returns only approved profiles visible to the credential", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "vendor/model-two", object: "model" },
        { id: "unapproved/model", object: "model" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(discoverManagedModelProfiles(
      policy,
      "test-key",
      DEFAULT_AI_RUNTIME_PREFERENCES
    )).resolves.toEqual([
      "model-two"
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://models.example.test/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer test-key" })
      })
    );
  });

  it("distinguishes rejected credentials from invalid catalog responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    await expect(discoverManagedModelProfiles(
      policy,
      "bad-key",
      DEFAULT_AI_RUNTIME_PREFERENCES
    )).rejects.toMatchObject({
      code: "managed_catalog_auth_rejected"
    } satisfies Partial<ManagedCatalogError>);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(discoverManagedModelProfiles(
      policy,
      "test-key",
      DEFAULT_AI_RUNTIME_PREFERENCES
    )).rejects.toMatchObject({
      code: "managed_catalog_invalid_response"
    } satisfies Partial<ManagedCatalogError>);
  });
});
