// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectAssetContentCached,
  type ProjectAssetContentResponse
} from "@/lib/api";
import { useWorkspaceAssets } from "@/pages/workspace/hooks/useWorkspaceAssets";
import type { AssetMeta } from "@/pages/workspace/types";
import { coreWorkspaceBackend } from "@/workspace/coreWorkspaceBackend";
import { ApplicationRuntimeProvider } from "@/composition/applicationRuntime";
import { createTestApplicationRuntime } from "@/testSupport/applicationRuntime";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getProjectAssetContentCached: vi.fn(),
  };
});

function wrapper({ children }: PropsWithChildren) {
  return createElement(
    ApplicationRuntimeProvider,
    {
      runtime: createTestApplicationRuntime({ workspace: coreWorkspaceBackend }),
      children,
    },
  );
}

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
      { initialProps: { projectId: "project-a" }, wrapper }
    );

    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const oldLoad = result.current.ensureLiveAssetLoaded("image.png");

    rerender({ projectId: "project-b" });
    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const currentLoad = result.current.ensureLiveAssetLoaded("image.png");

    await act(async () => {
      projectA.resolve(assetResponse("project-a", "b2xkLXByb2plY3Q="));
      await oldLoad;
    });
    expect(result.current.assetBase64).toEqual({});

    await act(async () => {
      projectB.resolve(assetResponse("project-b", "Y3VycmVudC1wcm9qZWN0"));
      await currentLoad;
    });
    expect(result.current.assetBase64).toEqual({
      "image.png": "Y3VycmVudC1wcm9qZWN0"
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
      { initialProps: { sessionGeneration: "access-a" }, wrapper },
    );

    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const staleLoad = result.current.ensureLiveAssetLoaded("image.png");
    rerender({ sessionGeneration: "access-b" });
    act(() => result.current.reconcileAssetCatalog(assetMeta));
    const currentLoad = result.current.ensureLiveAssetLoaded("image.png");

    await act(async () => {
      stale.resolve(assetResponse("project-a", "c3RhbGUtYWNjZXNz"));
      await staleLoad;
    });
    expect(result.current.assetBase64).toEqual({});

    await act(async () => {
      current.resolve(assetResponse("project-a", "Y3VycmVudC1hY2Nlc3M="));
      await currentLoad;
    });
    expect(result.current.assetBase64).toEqual({
      "image.png": "Y3VycmVudC1hY2Nlc3M=",
    });
  });
});
