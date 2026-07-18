// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectFile,
  deleteProjectFile,
  downloadProjectArchive,
  moveProjectFile,
  upsertDocumentByPath,
  uploadProjectAsset,
} from "@/lib/api";
import { useWorkspaceFileActions } from "@/pages/workspace/hooks/useWorkspaceFileActions";
import { coreWorkspaceBackend } from "@/workspace/coreWorkspaceBackend";
import { ApplicationRuntimeProvider } from "@/composition/applicationRuntime";
import { createTestApplicationRuntime } from "@/testSupport/applicationRuntime";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createProjectFile: vi.fn(),
    deleteProjectFile: vi.fn(),
    downloadProjectArchive: vi.fn(),
    moveProjectFile: vi.fn(),
    upsertDocumentByPath: vi.fn(),
    uploadProjectAsset: vi.fn(),
  };
});

function wrapper({ children }: PropsWithChildren) {
  return (
    <ApplicationRuntimeProvider
      runtime={createTestApplicationRuntime({ workspace: coreWorkspaceBackend })}
    >
      {children}
    </ApplicationRuntimeProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useWorkspaceFileActions", () => {
  beforeEach(() => {
    for (const mock of [
      createProjectFile,
      deleteProjectFile,
      downloadProjectArchive,
      moveProjectFile,
      upsertDocumentByPath,
      uploadProjectAsset,
    ]) {
      vi.mocked(mock).mockReset();
    }
  });

  it("does not publish an old project mutation after navigation", async () => {
    const creation = deferred<void>();
    vi.mocked(createProjectFile).mockReturnValue(creation.promise);
    const refreshProjectData = vi.fn().mockResolvedValue(undefined);
    const selectActivePath = vi.fn();
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useWorkspaceFileActions({
          projectId,
          sessionGeneration: projectId,
          projectName: projectId,
          projectType: "typst",
          contentEpoch: 0,
          activePath: "main.typ",
          entryFilePath: "main.typ",
          canWrite: true,
          isRevisionMode: false,
          selectActivePath,
          updateDocumentContent: vi.fn(),
          refreshProjectData,
          t: (key) => key,
        }),
      { initialProps: { projectId: "project-a" }, wrapper },
    );
    act(() => {
      result.current.setPathDialog({
        mode: "create",
        kind: "file",
        parentPath: "",
        value: "late.typ",
      });
    });
    let mutation: Promise<void>;
    act(() => {
      mutation = result.current.submitPathDialog();
    });
    rerender({ projectId: "project-b" });

    await act(async () => {
      creation.resolve();
      await mutation;
    });

    expect(refreshProjectData).not.toHaveBeenCalled();
    expect(selectActivePath).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});
