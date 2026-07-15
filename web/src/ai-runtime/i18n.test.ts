import { describe, expect, it } from "vitest";
import { aiRuntimeMessages } from "@/ai-runtime/i18n";

describe("AI Runtime translations", () => {
  it("defines the same isolated UI surface in English and Simplified Chinese", () => {
    const english = aiRuntimeMessages("en");
    const chinese = aiRuntimeMessages("zh-CN");

    expect(Object.keys(chinese.status)).toEqual(Object.keys(english.status));
    expect(Object.keys(chinese.errors)).toEqual(Object.keys(english.errors));
    expect(chinese.fakeResponse).toHaveLength(english.fakeResponse.length);
    expect(chinese.label).toMatch(/[\u3400-\u9fff]/);
    expect(chinese.fakeResponse.join("")).toMatch(/[\u3400-\u9fff]/);
  });
});
