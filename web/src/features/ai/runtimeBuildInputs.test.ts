import { describe, expect, it } from "vitest";
import { aiRuntimeBuildInputs } from "../../../aiRuntimeBuildConfig";

describe("AI Runtime build identity", () => {
  it("covers transitive production sources outside the runtime directory", () => {
    const inputs = aiRuntimeBuildInputs();

    expect(inputs).toContain("src/features/ai/providerRequest.ts");
    expect(inputs).toContain("src/features/ai/protocol.ts");
    expect(inputs).toContain("src/ai-runtime/runtime.ts");
    expect(inputs.some((input) => /\.test\.[^.]+$/.test(input))).toBe(false);
  });
});
