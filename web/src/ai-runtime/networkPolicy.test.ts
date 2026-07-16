// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isBoundAiRuntimeRequest } from "@/ai-runtime/networkPolicy";

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
});
