import { describe, expect, it } from "vitest";
import { queryTypstDocs, TYPST_DOCS_VERSION } from "@/ai-runtime/typstDocsSearch";

describe("Typst documentation search", () => {
  it("combines a verified metadata recipe with the exact standard-library API", async () => {
    const result = await queryTypstDocs("document metadata author keywords", 5);

    expect(result.version).toBe("0.15.0");
    expect(result.results[0]).toMatchObject({
      kind: "recipe",
      name: "document-metadata"
    });
    const document = result.results.find((entry) => entry.name === "document");
    expect(document).toMatchObject({
      kind: "function",
      source_url: "https://typst.app/docs/reference/model/document/"
    });
    expect(document?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "title", types: expect.arrayContaining(["content"]) }),
      expect.objectContaining({ name: "author", types: expect.arrayContaining(["str", "array"]) }),
      expect.objectContaining({ name: "keywords", types: expect.arrayContaining(["str", "array"]) })
    ]));
  });

  it("ranks exact API names ahead of broader matches", async () => {
    const result = await queryTypstDocs("document", 3);

    expect(result.results[0]).toMatchObject({ kind: "function", name: "document" });
  });

  it("uses the bundled BM25 aliases and parameter text", async () => {
    const image = await queryTypstDocs("image width fit", 5);
    const symbol = await queryTypstDocs("rightarrow", 5);

    expect(image.results.some((entry) => entry.name === "image")).toBe(true);
    expect(symbol.results.some((entry) => (
      entry.kind === "symbol" && typeof entry.name === "string"
    ))).toBe(true);
  });

  it("bounds result count and serialized output", async () => {
    const result = await queryTypstDocs("text", 100);

    expect(result.version).toBe(TYPST_DOCS_VERSION);
    expect(result.results.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(16_384);
    expect(result.truncated).toBe(true);
  });
});
