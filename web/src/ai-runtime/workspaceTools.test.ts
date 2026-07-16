import { describe, expect, it, vi } from "vitest";
import type { AiRuntimeToolBridge } from "@/ai-runtime/toolBridge";
import { createAiWorkspaceTools } from "@/ai-runtime/workspaceTools";

const verification = {
  status: "passed" as const,
  errors: [],
  diagnostics: [],
  truncated: false
};

describe("AI Runtime Workspace tools", () => {
  it("terminates the Agent loop after handing a compiled edit to human review", async () => {
    const bridge = {
      call: vi.fn(async () => ({
        path: "main.typ",
        base_snapshot: "sha256-base",
        status: "review_pending" as const,
        review_id: "review-1",
        verification
      }))
    } as unknown as AiRuntimeToolBridge;
    const [tool] = createAiWorkspaceTools({
      project_type: "typst",
      mode: "live",
      tools: ["apply_patch"]
    }, bridge);

    const result = await tool.execute("call-1", {
      path: "main.typ",
      base_snapshot: "sha256-base",
      patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1 +1 @@\n-= Old\n+= New"
    });

    expect(result).toMatchObject({
      terminate: true,
      details: { tool: "apply_patch", outcome: "success" }
    });
  });

  it("continues the Agent loop when isolated candidate compilation fails", async () => {
    const bridge = {
      call: vi.fn(async () => ({
        path: "main.typ",
        base_snapshot: "sha256-base",
        status: "compile_failed" as const,
        review_id: null,
        verification: {
          status: "failed" as const,
          errors: ["main.typ:1: unexpected token"],
          diagnostics: [],
          truncated: false
        }
      }))
    } as unknown as AiRuntimeToolBridge;
    const [tool] = createAiWorkspaceTools({
      project_type: "typst",
      mode: "live",
      tools: ["write_file"]
    }, bridge);

    const result = await tool.execute("call-1", {
      path: "main.typ",
      base_snapshot: "sha256-base",
      content: "#broken("
    });

    expect(result.terminate).toBeUndefined();
  });
});
