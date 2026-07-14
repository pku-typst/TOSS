import { describe, expect, it } from "vitest";
import {
  isLatexGeneratedAuxiliaryPath,
  latexGeneratedAuxiliaryMissKeys,
  normalizeLatexWorkspacePath,
  parseLatexCompileDiagnostics,
  summarizeLatexCompileErrors,
  validateLatexCompileInput
} from "./latexRuntimeUtils";

describe("LaTeX workspace paths", () => {
  it("normalizes project-relative paths", () => {
    expect(normalizeLatexWorkspacePath(" /slides/sections/intro.tex ")).toBe(
      "slides/sections/intro.tex"
    );
  });

  it.each(["../secret.tex", "chapters/../../secret.tex", "a//b.tex", "a\\b.tex"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => normalizeLatexWorkspacePath(path)).toThrow("Invalid LaTeX workspace path");
    }
  );

  it("rejects duplicate paths and oversized source input before worker cloning", () => {
    expect(() =>
      validateLatexCompileInput({
        documents: [{ path: "main.tex", content: "hello" }],
        assets: [{ path: "/main.tex", contentBase64: "aGVsbG8=" }]
      })
    ).toThrow("Duplicate LaTeX workspace path");

    expect(() =>
      validateLatexCompileInput({
        documents: [{ path: "main.tex", content: "x".repeat(16 * 1024 * 1024 + 1) }],
        assets: []
      })
    ).toThrow("LaTeX compile file is too large");
  });

});

describe("LaTeX generated auxiliary files", () => {
  it("classifies generated files without treating source or package files as auxiliary", () => {
    expect(isLatexGeneratedAuxiliaryPath("main.aux")).toBe(true);
    expect(isLatexGeneratedAuxiliaryPath("chapters/intro.run.xml")).toBe(true);
    expect(isLatexGeneratedAuxiliaryPath("article.cls")).toBe(false);
    expect(isLatexGeneratedAuxiliaryPath("xcolor.sty")).toBe(false);
  });

  it("builds unique TeX-format misses from document basenames", () => {
    const misses = latexGeneratedAuxiliaryMissKeys([
      { path: "paper/main.tex" },
      { path: "chapters/intro.ltx" },
      { path: "duplicate/main.tex" },
      { path: "references.bib" },
    ]);
    expect(new Set(misses).size).toBe(misses.length);
    expect(misses).toEqual(
      expect.arrayContaining([
        "26/main.aux",
        "26/main.out",
        "26/intro.run.xml",
      ]),
    );
    expect(misses.some((key) => key.includes("references"))).toBe(false);
  });
});

describe("LaTeX diagnostics", () => {
  it("extracts file and line information from file-line-error output", () => {
    const diagnostics = parseLatexCompileDiagnostics(
      "sections/intro.tex:17: Undefined control sequence"
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        path: "sections/intro.tex",
        line: 17,
        column: 1,
        message: "Undefined control sequence"
      })
    ]);
  });

  it("keeps the useful context around classic TeX errors", () => {
    const log = "(./main.tex\n! Undefined control sequence.\nl.4 \\missingcommand\n";
    expect(summarizeLatexCompileErrors(log)).toEqual([
      "! Undefined control sequence. l.4 \\missingcommand"
    ]);
    expect(parseLatexCompileDiagnostics(log)[0]?.raw).toContain("l.4 \\missingcommand");
  });
});
