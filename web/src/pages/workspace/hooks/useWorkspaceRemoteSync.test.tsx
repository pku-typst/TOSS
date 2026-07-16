// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import { saveProjectSnapshotToCache } from "@/lib/projectCache";
import { useWorkspaceRemoteSync } from "@/pages/workspace/hooks/useWorkspaceRemoteSync";
import {
  loadWorkspaceDelta,
  type WorkspaceDelta
} from "@/pages/workspace/loaders";
import {
  workspaceSessionMachine,
  type WorkspaceSessionScope,
} from "@/pages/workspace/workspaceSessionActor";

vi.mock("@/lib/projectCache", () => ({
  saveProjectSnapshotToCache: vi.fn()
}));

vi.mock("@/pages/workspace/loaders", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/pages/workspace/loaders")
  >();
  return {
    ...actual,
    loadWorkspaceDelta: vi.fn()
  };
});

const WORKSPACE_DELTA: WorkspaceDelta = {
  projectType: "typst",
  latexEngine: "xetex",
  entryFilePath: "main.typ",
  settingsRevision: 0,
  nodes: [{ path: "main.typ", kind: "file" }],
  contentEpoch: 1,
  documents: {},
  documentIdentities: {},
  documentsChangeSequence: 1,
  assetMeta: {}
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function input(
  realtimeCatchUpSequence: number,
  workspaceChangeSequence: number,
  generation = "user-a\u0000project-a\u0000readable",
) {
  const scope: WorkspaceSessionScope = {
    generation,
    projectId: "project-a",
    cacheIdentity: "user-a",
    projectTypeHint: "typst",
    latexEngineHint: "xetex",
    defaultEntry: "main.typ",
    unavailable: false,
  };
  const sessionActor = createActor(workspaceSessionMachine, {
    input: scope,
  }).start();
  sessionActor.send({ type: "session.started", scope, seed: null });
  sessionActor.send({
    type: "bootstrap.succeeded",
    generation: scope.generation,
    bootstrap: {
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "main.typ",
      settingsRevision: 0,
      nodes: [{ path: "main.typ", kind: "file" }],
      contentEpoch: 1,
      gitRepoUrl: "",
      shareLinks: [],
      documents: { "main.typ": "hello" },
      documentIdentities: {
        "main.typ": {
          id: "document-a",
          pathRevision: 0,
          collaborationRevision: 0,
        },
      },
      documentsChangeSequence: null,
      assetMeta: {},
    },
  });
  return {
    sessionActor,
    workspaceSyncPending: false,
    realtimeCatchUpSequence,
    workspaceChangeSequence,
    workspaceStructuralChangeSequence: workspaceChangeSequence,
    workspaceDocumentChanges: {},
    isRevisionMode: false,
    hasActiveLiveDocument: true,
    activeLiveDocumentReady: true,
    activeDocumentText: "hello",
    lastSavedDocument: "hello",
    reconcileAssetCatalog: vi.fn()
  };
}

beforeEach(() => {
  vi.mocked(loadWorkspaceDelta).mockReset();
  vi.mocked(loadWorkspaceDelta).mockResolvedValue(WORKSPACE_DELTA);
  vi.mocked(saveProjectSnapshotToCache).mockReset();
});

afterEach(() => vi.useRealTimers());

describe("useWorkspaceRemoteSync", () => {
  it("loads only for realtime invalidation and connection catch-up signals", async () => {
    const initial = input(0, 0);
    const { rerender } = renderHook(
      ({ connection, workspace, ready }) =>
        useWorkspaceRemoteSync({
          ...initial,
          realtimeCatchUpSequence: connection,
          workspaceChangeSequence: workspace,
          workspaceStructuralChangeSequence: workspace,
          activeLiveDocumentReady: ready
        }),
      { initialProps: { connection: 0, workspace: 0, ready: true } }
    );

    await act(async () => Promise.resolve());
    expect(loadWorkspaceDelta).not.toHaveBeenCalled();

    rerender({ connection: 1, workspace: 0, ready: true });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledTimes(1));

    rerender({ connection: 1, workspace: 1, ready: true });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledTimes(2));
    expect(loadWorkspaceDelta).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        afterDocumentsChangeSequence: 1
      })
    );

    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(loadWorkspaceDelta).toHaveBeenCalledTimes(2);
  });

  it("holds invalidations until the active Yjs bootstrap is ready", async () => {
    const initial = input(0, 0);
    const { rerender } = renderHook(
      ({ workspace, ready }) =>
        useWorkspaceRemoteSync({
          ...initial,
          workspaceChangeSequence: workspace,
          workspaceStructuralChangeSequence: workspace,
          activeLiveDocumentReady: ready
        }),
      { initialProps: { workspace: 0, ready: false } }
    );

    rerender({ workspace: 1, ready: false });
    await act(async () => Promise.resolve());
    expect(loadWorkspaceDelta).not.toHaveBeenCalled();

    rerender({ workspace: 1, ready: true });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledOnce());
  });

  it("does not refetch SQL state for the active Yjs document at the same revision", async () => {
    const initial = input(0, 0);
    const { rerender } = renderHook(
      ({ sequence, collaborationRevision }) =>
        useWorkspaceRemoteSync({
          ...initial,
          workspaceChangeSequence: sequence,
          workspaceStructuralChangeSequence: 0,
          workspaceDocumentChanges:
            sequence === 0
              ? {}
              : {
                  "main.typ": {
                    sequence,
                    documentId: "document-a",
                    collaborationRevision,
                    changeSequence: sequence
                  }
                }
        }),
      { initialProps: { sequence: 0, collaborationRevision: 0 } }
    );

    rerender({ sequence: 1, collaborationRevision: 0 });
    await act(async () => Promise.resolve());
    expect(loadWorkspaceDelta).not.toHaveBeenCalled();

    rerender({ sequence: 2, collaborationRevision: 1 });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledOnce());
  });

  it("does not settle a manual sync on an older in-flight cycle", async () => {
    const first = deferred<WorkspaceDelta>();
    const second = deferred<WorkspaceDelta>();
    vi.mocked(loadWorkspaceDelta)
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const initial = input(0, 0);
    const { result, rerender } = renderHook(
      ({ workspace }) =>
        useWorkspaceRemoteSync({
          ...initial,
          workspaceChangeSequence: workspace,
          workspaceStructuralChangeSequence: workspace
        }),
      { initialProps: { workspace: 0 } }
    );
    rerender({ workspace: 1 });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledOnce());

    let manualSettled = false;
    let manualSync: Promise<void> | undefined;
    act(() => {
      manualSync = result.current();
      void manualSync.then(() => {
        manualSettled = true;
      });
    });
    await act(async () => {
      first.resolve(WORKSPACE_DELTA);
      await first.promise;
    });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledTimes(2));
    expect(manualSettled).toBe(false);

    await act(async () => {
      second.resolve(WORKSPACE_DELTA);
      await second.promise;
      await manualSync;
    });
    expect(manualSettled).toBe(true);
  });

  it("cancels a manual sync when its Workspace session is replaced", async () => {
    const pending = deferred<WorkspaceDelta>();
    vi.mocked(loadWorkspaceDelta).mockReset().mockReturnValue(pending.promise);
    const sessionA = input(0, 0, "session-a");
    const sessionB = input(0, 0, "session-b");
    const { result, rerender } = renderHook(
      ({ current, workspace }) =>
        useWorkspaceRemoteSync({
          ...current,
          workspaceChangeSequence: workspace,
          workspaceStructuralChangeSequence: workspace,
        }),
      { initialProps: { current: sessionA, workspace: 0 } },
    );
    rerender({ current: sessionA, workspace: 1 });
    await waitFor(() => expect(loadWorkspaceDelta).toHaveBeenCalledOnce());

    let manualSettled = false;
    act(() => {
      void result.current().then(() => {
        manualSettled = true;
      });
    });
    rerender({ current: sessionB, workspace: 0 });

    await waitFor(() => expect(manualSettled).toBe(true));
    expect(loadWorkspaceDelta).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(WORKSPACE_DELTA);
      await pending.promise;
    });
  });
});
