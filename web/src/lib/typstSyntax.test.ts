import { describe, expect, it } from "vitest";
import { checkTypstSyntax } from "@/lib/typstSyntax";

describe("Typst syntax precheck", () => {
  it("accepts syntactically valid Typst without compiler initialization", () => {
    expect(checkTypstSyntax(
      "main.typ",
      "#set document(title: [Hello])\n= A valid document",
    )).toEqual([]);
  });

  it("reports the first parser recovery error", () => {
    expect(checkTypstSyntax("main.typ", "#let value = )")).toEqual([{
      severity: "error",
      message: "The Typst syntax parser found invalid or incomplete syntax.",
      path: "main.typ",
      line: 1,
      column: 13,
      raw:
        "main.typ:1:13: The Typst syntax parser found invalid or incomplete syntax.",
    }]);
  });

  it("returns only the first actionable error instead of recovery cascades", () => {
    const diagnostics = checkTypstSyntax(
      "main.typ",
      "#let broken = (\n\n= Valid markup after the broken expression",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      path: "main.typ",
      line: 1,
      column: 15,
    });
  });

  it("uses editor-compatible UTF-16 line and column positions", () => {
    expect(checkTypstSyntax("chapters/intro.typ", "中文😀\n#let value = (")).toEqual([{
      severity: "error",
      message: "The Typst syntax parser found invalid or incomplete syntax.",
      path: "chapters/intro.typ",
      line: 2,
      column: 14,
      raw:
        "chapters/intro.typ:2:14: The Typst syntax parser found invalid or incomplete syntax.",
    }]);
  });
});
