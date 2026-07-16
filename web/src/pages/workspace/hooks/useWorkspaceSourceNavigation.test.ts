// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createActor } from "xstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TypstDocumentPosition } from "@/lib/typstSync";
import type { TypstMappingState } from "@/pages/workspace/compilationActor";
import {
  CompileWorldProjector,
  type CompileWorld,
} from "@/pages/workspace/compileWorld";
import { useWorkspaceSourceNavigation } from "@/pages/workspace/hooks/useWorkspaceSourceNavigation";
import { workspaceSessionMachine } from "@/pages/workspace/workspaceSessionActor";

const mappingMocks = vi.hoisted(() => ({
  sourceToDocument: vi.fn(),
  documentToSource: vi.fn(),
}));

vi.mock("@/lib/typst", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/typst")>();
  return {
    ...original,
    resolveTypstSourceToDocument: mappingMocks.sourceToDocument,
    resolveTypstDocumentToSource: mappingMocks.documentToSource,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function world(content: string) {
  return new CompileWorldProjector().project({
    scope: "project-a:live",
    projectType: "typst",
    entryFilePath: "main.typ",
    documents: { "main.typ": content },
    assets: {},
  });
}

function sessionActor() {
  return createActor(workspaceSessionMachine, {
    input: {
      generation: "session-a",
      projectId: "project-a",
      cacheIdentity: "user-a",
      projectTypeHint: "typst",
      latexEngineHint: "xetex",
      defaultEntry: "main.typ",
      unavailable: false,
    },
  }).start();
}

describe("useWorkspaceSourceNavigation", () => {
  beforeEach(() => {
    mappingMocks.sourceToDocument.mockReset();
    mappingMocks.documentToSource.mockReset();
  });

  it("rejects a deferred source mapping after the current World changes", async () => {
    const pending = deferred<TypstDocumentPosition[]>();
    mappingMocks.sourceToDocument.mockReturnValue(pending.promise);
    const firstWorld = world("first");
    const secondWorld = world("second");
    const mappingRef: { current: TypstMappingState | null } = {
      current: { revision: 1, world: firstWorld },
    };
    const actor = sessionActor();
    const { result, rerender, unmount } = renderHook(
      ({ compileWorld }: { compileWorld: CompileWorld }) =>
        useWorkspaceSourceNavigation({
          activePath: "main.typ",
          sessionGeneration: "session-a",
          sessionActor: actor,
          world: compileWorld,
          mappingRef,
          singlePanelMode: false,
          selectCompactPanel: vi.fn(),
          selectActivePath: vi.fn(),
          setExpandedDirs: vi.fn(),
        }),
      { initialProps: { compileWorld: firstWorld } },
    );

    let response!: Promise<TypstDocumentPosition | null>;
    act(() => {
      response = result.current.resolveSourceClickToPreview(
        { line: 1, column: 1, offset: 1 },
        0,
      );
    });
    expect(mappingMocks.sourceToDocument).toHaveBeenCalledTimes(1);

    mappingRef.current = { revision: 2, world: secondWorld };
    rerender({ compileWorld: secondWorld });
    pending.resolve([{ pageOffset: 0, x: 10, y: 20 }]);

    await expect(response).resolves.toBeNull();
    unmount();
    actor.stop();
  });

  it("does not reveal a deferred preview mapping from a superseded World", async () => {
    const pending = deferred<{ path: string; byteOffset: number }>();
    mappingMocks.documentToSource.mockReturnValue(pending.promise);
    const firstWorld = world("first");
    const secondWorld = world("second");
    const mappingRef: { current: TypstMappingState | null } = {
      current: { revision: 1, world: firstWorld },
    };
    const selectActivePath = vi.fn();
    const setExpandedDirs = vi.fn();
    const actor = sessionActor();
    const { result, rerender, unmount } = renderHook(
      ({ compileWorld }: { compileWorld: CompileWorld }) =>
        useWorkspaceSourceNavigation({
          activePath: "main.typ",
          sessionGeneration: "session-a",
          sessionActor: actor,
          world: compileWorld,
          mappingRef,
          singlePanelMode: false,
          selectCompactPanel: vi.fn(),
          selectActivePath,
          setExpandedDirs,
        }),
      { initialProps: { compileWorld: firstWorld } },
    );

    let response!: Promise<void>;
    act(() => {
      response = result.current.handlePreviewPositionClick(
        { pageOffset: 0, x: 10, y: 20 },
        1,
      );
    });
    expect(mappingMocks.documentToSource).toHaveBeenCalledTimes(1);

    mappingRef.current = { revision: 2, world: secondWorld };
    rerender({ compileWorld: secondWorld });
    pending.resolve({ path: "main.typ", byteOffset: 1 });
    await response;

    expect(selectActivePath).not.toHaveBeenCalled();
    expect(setExpandedDirs).not.toHaveBeenCalled();
    unmount();
    actor.stop();
  });
});
