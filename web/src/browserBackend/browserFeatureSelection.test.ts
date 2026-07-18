import { describe, expect, it } from "vitest";
import { resolveBrowserFrontendFeatures } from "../../browserFeatureSelection";

const included = ["ai_assistant", "future_feature"];

describe("resolveBrowserFrontendFeatures", () => {
  it("uses distribution defaults when no static deployment override exists", () => {
    expect(
      resolveBrowserFrontendFeatures({
        included,
        defaultEnabled: ["future_feature"],
        configured: undefined,
      }),
    ).toEqual(["future_feature"]);
  });

  it("uses an explicit ordered static deployment selection", () => {
    expect(
      resolveBrowserFrontendFeatures({
        included,
        defaultEnabled: [],
        configured: " future_feature, ai_assistant ",
      }),
    ).toEqual(["future_feature", "ai_assistant"]);
  });

  it("allows a static deployment to explicitly disable all features", () => {
    expect(
      resolveBrowserFrontendFeatures({
        included,
        defaultEnabled: ["ai_assistant"],
        configured: " ",
      }),
    ).toEqual([]);
  });

  it.each([
    ["unknown", "not included"],
    ["ai_assistant,ai_assistant", "Duplicate"],
    ["ai_assistant,", "empty feature"],
  ])("rejects invalid selection %s", (configured, message) => {
    expect(() =>
      resolveBrowserFrontendFeatures({
        included,
        defaultEnabled: [],
        configured,
      }),
    ).toThrow(message);
  });
});
