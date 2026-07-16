// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectAssetContentCached,
  type ProjectAssetContentResponse
} from "@/lib/api";
import { useWorkspaceAssets } from "@/pages/workspace/hooks/useWorkspaceAssets";
import type { AssetMeta } from "@/pages/workspace/types";

vi.mock("@/lib/api", () => ({
  getProjectAssetContentCached: vi.fn()
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const assetMeta: Record<string, AssetMeta> = {
  "image.png": {
    id: "asset-id",
    contentRevision: "revision-1",
    contentType: "image/png",
    sizeBytes: 3,
    createdAt: "2026-01-01T00:00:00Z"
  }
};

function assetResponse(projectId: string, contentBase64: string): ProjectAssetContentResponse {
  return {
    asset: {
      id: "asset-id",
      project_id: projectId,
      path: "image.png",
      content_revision: "00000000-0000-4000-8000-000000000001",
      content_type: "image/png",
      size_bytes: 3,
      uploaded_by: null,
      created_at: "2026-01-01T00:00:00Z"
    },
    content_base64: contentBase64
  };
}

describe("useWorkspaceAssets", () => {
  beforeEach(() => {
    vi.mocked(getProjectAssetContentCached).mockReset();
  });

  it("does not publish an asset that finishes after the project changes", async () => {
    const projectA = deferred<ProjectAssetContentResponse>();
    const projectB = deferred<ProjectAssetContentResponse>();
    vi.mocked(getProjectAssetContentCached).mockImplementation(
      (_identity, projectId) =>
        projectId === "project-a" ? projectA.promise : projectB.promise
    );
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useWorkspaceAssets({
          projectId,
          effectiveUserId: "user",
          sessionGeneration: `user:${projectId}`,
          assetMeta,
        }),
      { initialProps: { projectId: "project-a" } }
    );

    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const oldLoad = result.current.ensureLiveAssetLoaded("image.png");

    rerender({ projectId: "project-b" });
    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const currentLoad = result.current.ensureLiveAssetLoaded("image.png");

    await act(async () => {
      projectA.resolve(assetResponse("project-a", "old-project"));
      await oldLoad;
    });
    expect(result.current.assetBase64).toEqual({});

    await act(async () => {
      projectB.resolve(assetResponse("project-b", "current-project"));
      await currentLoad;
    });
    expect(result.current.assetBase64).toEqual({
      "image.png": "current-project"
    });
  });

  it("does not publish an asset from an obsolete access session", async () => {
    const stale = deferred<ProjectAssetContentResponse>();
    const current = deferred<ProjectAssetContentResponse>();
    vi.mocked(getProjectAssetContentCached)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const { result, rerender } = renderHook(
      ({ sessionGeneration }) =>
        useWorkspaceAssets({
          projectId: "project-a",
          effectiveUserId: "user",
          sessionGeneration,
          assetMeta,
        }),
      { initialProps: { sessionGeneration: "access-a" } },
    );

    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const staleLoad = result.current.ensureLiveAssetLoaded("image.png");
    rerender({ sessionGeneration: "access-b" });
    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const currentLoad = result.current.ensureLiveAssetLoaded("image.png");

    await act(async () => {
      stale.resolve(assetResponse("project-a", "stale-access"));
      await staleLoad;
    });
    expect(result.current.assetBase64).toEqual({});

    await act(async () => {
      current.resolve(assetResponse("project-a", "current-access"));
      await currentLoad;
    });
    expect(result.current.assetBase64).toEqual({
      "image.png": "current-access",
    });
  });
});
