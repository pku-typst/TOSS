import { describe, expect, it } from "vitest";
import {
  applyAiProviderRequestOverrides,
  isAiProviderRequestOverrides,
  parseAiProviderRequestOverrides
} from "@/features/ai/providerRequest";

describe("AI Provider request overrides", () => {
  it("accepts documented provider-specific reasoning shapes without normalizing them", () => {
    expect(parseAiProviderRequestOverrides(JSON.stringify({
      reasoning: { effort: "high", summary: "auto" },
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_budget: 8_192,
        low_effort: false
      },
      nvext: { max_thinking_tokens: 4_096 }
    }))).toEqual({
      reasoning: { effort: "high", summary: "auto" },
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_budget: 8_192,
        low_effort: false
      },
      nvext: { max_thinking_tokens: 4_096 }
    });
  });

  it("deep-merges objects, replaces arrays, and leaves the generated payload untouched", () => {
    const payload = {
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      chat_template_kwargs: { preserve_thinking: true },
      include: ["usage"]
    };
    const merged = applyAiProviderRequestOverrides(payload, {
      chat_template_kwargs: { enable_thinking: true, reasoning_budget: 2_048 },
      include: ["reasoning.encrypted_content"]
    });

    expect(merged).toEqual({
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      chat_template_kwargs: {
        preserve_thinking: true,
        enable_thinking: true,
        reasoning_budget: 2_048
      },
      include: ["reasoning.encrypted_content"]
    });
    expect(payload).toEqual({
      model: "model-1",
      messages: [{ role: "user", content: "hello" }],
      chat_template_kwargs: { preserve_thinking: true },
      include: ["usage"]
    });
  });

  it("rejects core Agent fields, credentials, non-objects, and unsafe object keys", () => {
    expect(isAiProviderRequestOverrides({ messages: [] })).toBe(false);
    expect(isAiProviderRequestOverrides({ stream: false })).toBe(false);
    expect(isAiProviderRequestOverrides({ headers: { Authorization: "secret" } })).toBe(false);
    expect(isAiProviderRequestOverrides({ nvext: { api_key: "secret" } })).toBe(false);
    expect(isAiProviderRequestOverrides({ auth: { accessToken: "secret" } })).toBe(false);
    expect(isAiProviderRequestOverrides(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
    expect(parseAiProviderRequestOverrides("[]")).toBeNull();
    expect(parseAiProviderRequestOverrides("not-json")).toBeNull();
  });

  it("rejects cyclic and oversized values at the protocol boundary", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isAiProviderRequestOverrides(cyclic)).toBe(false);
    expect(isAiProviderRequestOverrides({ value: "x".repeat(8_193) })).toBe(false);
  });
});
