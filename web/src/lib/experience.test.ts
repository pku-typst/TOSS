import { describe, expect, it } from "vitest";
import { localizedText, safeReturnPath } from "@/lib/experience";

describe("experience helpers", () => {
  it("localizes configured text with an English fallback", () => {
    const value = { en: "Help", "zh-CN": "帮助" };
    expect(localizedText(value, "zh-CN")).toBe("帮助");
    expect(localizedText(value, "en")).toBe("Help");
  });

  it("keeps safe same-origin return paths", () => {
    expect(safeReturnPath("/gallery?source=personal#top")).toBe("/gallery?source=personal#top");
    expect(safeReturnPath("/project/123")).toBe("/project/123");
  });

  it("rejects external, malformed, and recursive sign-in destinations", () => {
    expect(safeReturnPath("https://example.com/steal")).toBe("/projects");
    expect(safeReturnPath("//example.com/steal")).toBe("/projects");
    expect(safeReturnPath("/signin?returnTo=/signin")).toBe("/projects");
    expect(safeReturnPath("/project\\123")).toBe("/projects");
  });
});
