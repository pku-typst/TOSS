// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  isBoundAiRuntimeRequest,
  isManagedAiRuntimeRequest
} from "@/ai-runtime/networkPolicy";

const endpoint = {
  baseUrl: "https://models.example.test/v1",
  origin: "https://models.example.test"
};

describe("AI Runtime bound fetch policy", () => {
  it("allows only GET and POST requests below the full configured base URL", () => {
    expect(isBoundAiRuntimeRequest("https://models.example.test/v1/chat/completions", { method: "POST" }, endpoint)).toBe(true);
    expect(isBoundAiRuntimeRequest("https://models.example.test/v1/models", undefined, endpoint)).toBe(true);
    expect(isBoundAiRuntimeRequest("https://models.example.test/v2/chat/completions", { method: "POST" }, endpoint)).toBe(false);
    expect(isBoundAiRuntimeRequest("https://other.example.test/v1/chat/completions", { method: "POST" }, endpoint)).toBe(false);
    expect(isBoundAiRuntimeRequest("https://models.example.test/v1/models", { method: "DELETE" }, endpoint)).toBe(false);
  });

  it("allows only model discovery and chat completions for a managed provider", () => {
    const provider = {
      id: "managed-provider",
      label: { en: "Provider", "zh-CN": "提供方" },
      credentialLabel: { en: "API key", "zh-CN": "API 密钥" },
      protocol: "openai-completions" as const,
      baseUrl: "https://models.example.test/v1/",
      catalog: "openai-models" as const
    };
    expect(isManagedAiRuntimeRequest(
      "https://models.example.test/v1/models",
      { method: "GET" },
      provider
    )).toBe(true);
    expect(isManagedAiRuntimeRequest(
      "https://models.example.test/v1/chat/completions",
      { method: "POST" },
      provider
    )).toBe(true);
    expect(isManagedAiRuntimeRequest(
      "https://models.example.test/v1/models",
      { method: "POST" },
      provider
    )).toBe(false);
    expect(isManagedAiRuntimeRequest(
      "https://models.example.test/v1/embeddings",
      { method: "POST" },
      provider
    )).toBe(false);
    expect(isManagedAiRuntimeRequest(
      "https://models.example.test/v1/models?scope=all",
      { method: "GET" },
      provider
    )).toBe(false);
  });
});
