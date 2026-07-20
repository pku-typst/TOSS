import { describe, expect, it, vi } from "vitest";
import { createTypstDocsTools } from "@/ai-runtime/typstDocsTool";

const typstCapabilities = {
  project_type: "typst" as const,
  mode: "live" as const,
  tools: ["read_project_file" as const]
};

describe("Typst documentation Agent tool", () => {
  it("is exposed only for Typst projects", () => {
    expect(createTypstDocsTools(typstCapabilities).map(({ name }) => name)).toEqual([
      "query_typst_docs"
    ]);
    expect(createTypstDocsTools({
      ...typstCapabilities,
      project_type: "latex"
    })).toEqual([]);
    expect(createTypstDocsTools(null)).toEqual([]);
  });

  it("localizes only the host label and returns local results", async () => {
    const onQuery = vi.fn();
    const tool = createTypstDocsTools(typstCapabilities, "zh-CN", { onQuery })[0];
    const englishTool = createTypstDocsTools(typstCapabilities, "en")[0];

    expect(tool.label).not.toBe(englishTool.label);
    expect(tool.description).toBe(englishTool.description);
    const result = await tool.execute(
      "docs-call",
      { query: "document metadata", limit: 2 },
      new AbortController().signal
    );
    const payload = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}");
    expect(payload).toMatchObject({ version: "0.15.0", query: "document metadata" });
    expect(payload.results.length).toBeGreaterThan(0);
    expect(onQuery).toHaveBeenCalledOnce();
  });
});
