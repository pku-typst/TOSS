import { describe, expect, it } from "vitest";
import {
  compileWorldFontData,
  CompileWorldProjector,
  type CompileWorldInput,
} from "@/pages/workspace/compileWorld";

function input(
  documents: Record<string, string>,
  assets: Record<string, string> = {},
): CompileWorldInput {
  return {
    scope: "project-a:live",
    projectType: "typst",
    entryFilePath: "main.typ",
    documents,
    assets,
  };
}

describe("CompileWorldProjector", () => {
  it("projects equal-length changes anywhere in an inactive document", () => {
    const projector = new CompileWorldProjector();
    const prefix = "p".repeat(48);
    const suffix = "s".repeat(48);
    const first = projector.project(
      input({
        "main.typ": "#include \"chapter.typ\"",
        "chapter.typ": `${prefix}A${suffix}`,
      }),
    );
    const second = projector.project(
      input({
        "main.typ": "#include \"chapter.typ\"",
        "chapter.typ": `${prefix}B${suffix}`,
      }),
    );

    expect(second).not.toBe(first);
    expect(second.source("chapter.typ")).toContain("B");
    expect(first.source("chapter.typ")).toContain("A");
  });

  it("projects equal-length changes anywhere in an asset", () => {
    const projector = new CompileWorldProjector();
    const prefix = "p".repeat(48);
    const suffix = "s".repeat(48);
    const first = projector.project(
      input({ "main.typ": "hello" }, { "image.bin": `${prefix}A${suffix}` }),
    );
    const second = projector.project(
      input({ "main.typ": "hello" }, { "image.bin": `${prefix}B${suffix}` }),
    );

    expect(second).not.toBe(first);
    expect(first.assets[0]?.contentBase64).toContain("A");
    expect(second.assets[0]?.contentBase64).toContain("B");
  });

  it("keeps published Worlds immutable while an active document changes", () => {
    const projector = new CompileWorldProjector();
    const firstInput = input({ "main.typ": "stored" });
    firstInput.activeDocument = { path: "main.typ", content: "first" };
    const first = projector.project(firstInput);
    const secondInput = input({ "main.typ": "stored" });
    secondInput.activeDocument = { path: "main.typ", content: "second" };
    const second = projector.project(secondInput);

    expect(first.documents[0]?.content).toBe("first");
    expect(second.documents[0]?.content).toBe("second");
    expect(second.documents[0]).not.toBe(first.documents[0]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.documents)).toBe(true);
    expect("fontCache" in first).toBe(false);
    expect("fontData" in first).toBe(false);
  });

  it("reuses decoded font buffers across unrelated asset changes", () => {
    const projector = new CompileWorldProjector();
    const font = btoa("font-data");
    const first = projector.project(
      input({ "main.typ": "hello" }, { "font.ttf": font, "image.bin": "one" }),
    );
    const second = projector.project(
      input({ "main.typ": "hello" }, { "font.ttf": font, "image.bin": "two" }),
    );

    expect(second).not.toBe(first);
    expect(compileWorldFontData(second)[0]).toBe(
      compileWorldFontData(first)[0],
    );
  });

  it("preserves unchanged file-node identities across Worlds", () => {
    const projector = new CompileWorldProjector();
    const first = projector.project(
      input(
        { "main.typ": "first", "chapter.typ": "stable" },
        { "logo.bin": "stable", "other.bin": "first" },
      ),
    );
    const second = projector.project(
      input(
        { "main.typ": "second", "chapter.typ": "stable" },
        { "logo.bin": "stable", "other.bin": "second" },
      ),
    );

    expect(second.documents.find(({ path }) => path === "chapter.typ")).toBe(
      first.documents.find(({ path }) => path === "chapter.typ"),
    );
    expect(second.assets.find(({ path }) => path === "logo.bin")).toBe(
      first.assets.find(({ path }) => path === "logo.bin"),
    );
  });

  it("replaces a decoded font buffer only when that font changes", () => {
    const projector = new CompileWorldProjector();
    const first = projector.project(
      input({ "main.typ": "hello" }, { "font.ttf": btoa("font-one") }),
    );
    const second = projector.project(
      input({ "main.typ": "hello" }, { "font.ttf": btoa("font-two") }),
    );

    expect(compileWorldFontData(second)[0]).not.toBe(
      compileWorldFontData(first)[0],
    );
  });

  it("returns the same World for exactly equivalent input", () => {
    const projector = new CompileWorldProjector();
    const first = projector.project(input({ "main.typ": "same" }));
    const second = projector.project(input({ "main.typ": "same" }));

    expect(second).toBe(first);
    expect(second.documents).toBe(first.documents);
  });
});
