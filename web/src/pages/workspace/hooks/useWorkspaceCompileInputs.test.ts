// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceCompileInputs } from "@/pages/workspace/hooks/useWorkspaceCompileInputs";

type HookProps = {
  documents: Record<string, string>;
  latexEngine: "pdftex" | "xetex";
};

function useInputs({ documents, latexEngine }: HookProps, rendered = () => {}) {
  rendered();
  return useWorkspaceCompileInputs({
    projectId: "project-a",
    activeRevisionId: null,
    isRevisionMode: false,
    projectType: "latex",
    latexEngine,
    entryFilePath: "main.tex",
    documents,
    assetBase64: {},
    liveAssetMeta: {},
    activePath: "main.tex",
    activeDocumentText: "",
    hasActiveLiveDocument: false,
    realtimeDocumentReady: false,
    realtimeBoundPath: "",
    typstPreviewRenderer: "canvas"
  });
}

describe("useWorkspaceCompileInputs", () => {
  it("projects a complete World once and models compiler configuration separately", () => {
    const rendered = vi.fn();
    const { result, rerender } = renderHook(
      (props: HookProps) => useInputs(props, rendered),
      {
      initialProps: {
        documents: { "main.tex": "first" },
        latexEngine: "xetex",
      },
      },
    );
    const firstWorld = result.current.world;
    expect(rendered).toHaveBeenCalledTimes(1);

    rerender({
      documents: { "main.tex": "second" },
      latexEngine: "xetex",
    });
    expect(rendered).toHaveBeenCalledTimes(2);
    expect(result.current.world.source("main.tex")).toBe("second");
    expect(result.current.world).not.toBe(firstWorld);

    const secondWorld = result.current.world;
    const secondTarget = result.current.target;
    rerender({
      documents: { "main.tex": "second" },
      latexEngine: "pdftex",
    });
    expect(rendered).toHaveBeenCalledTimes(3);
    expect(result.current.world).toBe(secondWorld);
    expect(result.current.target).not.toBe(secondTarget);
    expect(result.current.target).toEqual({ kind: "latex", engine: "pdftex" });
  });
});
