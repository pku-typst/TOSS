import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileWorkspaceCandidate } from "@/pages/workspace/candidateCompilation";
import type { CompileWorld } from "@/pages/workspace/compileWorld";

const { compileTypstCandidateClientSide } = vi.hoisted(() => ({
  compileTypstCandidateClientSide: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  coreApiBaseUrl: () => "http://localhost/api",
}));
vi.mock("@/lib/latex", () => ({
  compileLatexCandidateClientSide: vi.fn(),
}));
vi.mock("@/lib/typst", () => ({
  compileTypstCandidateClientSide,
}));

function world(main: string): CompileWorld {
  const documents = Object.freeze([
    Object.freeze({ path: "main.typ", content: main }),
  ]);
  return Object.freeze({
    scope: "project-a:assistant-candidate",
    projectType: "typst",
    entryFilePath: "main.typ",
    documents,
    assets: Object.freeze([]),
    source: (path: string) => path === "main.typ" ? main : undefined,
  });
}

describe("Workspace candidate compilation", () => {
  beforeEach(() => {
    compileTypstCandidateClientSide.mockReset();
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  });

  it("returns syntax errors without starting the candidate compiler", async () => {
    const result = await compileWorkspaceCandidate(
      world("#let value = ("),
      { kind: "typst", emitPdf: false },
      "main.typ",
    );

    expect(compileTypstCandidateClientSide).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      errors: [
        "main.typ:1:14: The Typst syntax parser found invalid or incomplete syntax.",
      ],
      diagnostics: [{
        severity: "error",
        path: "main.typ",
        line: 1,
        column: 14,
      }],
    });
  });

  it("runs the isolated diagnostics-only compiler after syntax passes", async () => {
    compileTypstCandidateClientSide.mockResolvedValue({
      errors: [],
      diagnostics: [{
        severity: "warning",
        message: "A semantic warning",
        raw: "warning: A semantic warning",
      }],
    });

    const result = await compileWorkspaceCandidate(
      world("#let value = 1\nValue: #value"),
      { kind: "typst", emitPdf: false },
      "main.typ",
    );

    expect(compileTypstCandidateClientSide).toHaveBeenCalledOnce();
    expect(compileTypstCandidateClientSide).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: "project-a:assistant-candidate",
        entryFilePath: "main.typ",
      }),
      undefined,
    );
    expect(result).toMatchObject({
      errors: [],
      diagnostics: [{ message: "A semantic warning" }],
    });
  });

  it("forwards cancellation to the isolated candidate compiler", async () => {
    const controller = new AbortController();
    compileTypstCandidateClientSide.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    await expect(compileWorkspaceCandidate(
      world("#let value = 1\nValue: #value"),
      { kind: "typst", emitPdf: false },
      "main.typ",
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(compileTypstCandidateClientSide).toHaveBeenCalledWith(
      expect.any(Object),
      controller.signal,
    );
  });
});
