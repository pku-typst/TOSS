// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectAssetContentCached,
  type Project,
  type ProjectAssetContentResponse,
} from "@/lib/api";
import {
  clearProjectSnapshotCaches,
  saveProjectSnapshotToCache,
} from "@/lib/projectCache";
import { useWorkspaceSession } from "@/pages/workspace/hooks/useWorkspaceSession";
import {
  loadWorkspaceBootstrap,
  type WorkspaceBootstrap,
} from "@/pages/workspace/loaders";
import { coreWorkspaceBackend } from "@/workspace/coreWorkspaceBackend";
import { ApplicationRuntimeProvider } from "@/composition/applicationRuntime";
import { createTestApplicationRuntime } from "@/testSupport/applicationRuntime";

vi.mock("@/pages/workspace/loaders", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/pages/workspace/loaders")>();
  return {
    ...original,
    loadWorkspaceBootstrap: vi.fn(),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    getProjectAssetContentCached: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function project(
  lastEditedAt = "2026-07-12T00:00:00Z",
  projectId = "project-a",
): Project {
  return {
    archived: false,
    archived_at: null,
    can_read: true,
    created_at: "2026-07-12T00:00:00Z",
    has_thumbnail: false,
    id: projectId,
    is_template: false,
    last_edited_at: lastEditedAt,
    latex_engine: null,
    my_role: "Owner",
    name: projectId,
    owner_display_name: "Owner",
    owner_user_id: "owner-a",
    project_type: "typst",
  };
}

function bootstrap(
  content: string,
  documentId = "document-a",
  withAsset = false,
): WorkspaceBootstrap {
  return {
    projectType: "typst",
    latexEngine: "xetex",
    entryFilePath: "main.typ",
    settingsRevision: 0,
    nodes: [{ path: "main.typ", kind: "file" }],
    contentEpoch: 3,
    documents: { "main.typ": content },
    documentIdentities: {
      "main.typ": {
        id: documentId,
        pathRevision: 0,
        collaborationRevision: 0,
      },
    },
    documentsChangeSequence: 1,
    assetMeta: withAsset
      ? {
          "image.png": {
            id: "asset-a",
            contentRevision: "revision-a",
            contentType: "image/png",
            sizeBytes: 3,
            createdAt: "2026-07-12T00:00:00Z",
          },
        }
      : {},
  };
}

function assetResponse(): ProjectAssetContentResponse {
  return {
    asset: {
      id: "asset-a",
      project_id: "project-a",
      path: "image.png",
      content_revision: "revision-a",
      content_type: "image/png",
      size_bytes: 3,
      uploaded_by: null,
      created_at: "2026-07-12T00:00:00Z",
    },
    content_base64: "aW1n",
  };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <ApplicationRuntimeProvider
        runtime={createTestApplicationRuntime({ workspace: coreWorkspaceBackend })}
      >
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ApplicationRuntimeProvider>
    );
  };
}

function renderWorkspaceSession(options?: {
  project?: Project;
  accessSessionKey?: string;
  offlineCacheIdentity?: string | null;
}) {
  const rendered = renderHook(
    ({
      projectId,
      currentProject,
      accessSessionKey,
      offlineCacheIdentity,
    }: {
      projectId: string;
      currentProject: Project;
      accessSessionKey: string;
      offlineCacheIdentity: string | null;
    }) =>
      useWorkspaceSession({
        projectId,
        project: currentProject,
        effectiveUserId: "user-a",
        offlineCacheIdentity,
        accessSessionKey,
        canWrite: true,
        cachedOfflineMessage: "cached-offline",
        loadErrorMessage: "load-failed",
      }),
    {
      wrapper: createWrapper(),
      initialProps: {
        projectId: options?.project?.id ?? "project-a",
        currentProject: options?.project ?? project(),
        accessSessionKey: options?.accessSessionKey ?? "user-a",
        offlineCacheIdentity:
          options && "offlineCacheIdentity" in options
            ? (options.offlineCacheIdentity ?? null)
            : "user-a",
      },
    },
  );
  return {
    ...rendered,
  };
}

describe("useWorkspaceSession", () => {
  beforeEach(() => {
    clearProjectSnapshotCaches();
    vi.mocked(loadWorkspaceBootstrap).mockReset();
    vi.mocked(getProjectAssetContentCached).mockReset();
    vi.mocked(getProjectAssetContentCached).mockResolvedValue(assetResponse());
  });

  it("shows a fresh offline seed while the server bootstrap is pending", async () => {
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "project-a",
      entryFilePath: "main.typ",
      nodes: [{ path: "main.typ", kind: "file" }],
      docs: { "main.typ": "= cached" },
    });
    const pending = deferred<WorkspaceBootstrap>();
    vi.mocked(loadWorkspaceBootstrap).mockReturnValue(pending.promise);

    const { result } = renderWorkspaceSession({
      project: project(new Date(Date.now() - 1000).toISOString()),
    });
    await waitFor(() => {
      expect(result.current.status.loaded).toBe(true);
      expect(result.current.projection.documents).toEqual({ "main.typ": "= cached" });
    });

    await act(async () => {
      pending.resolve(bootstrap("= server"));
      await pending.promise;
    });
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({ "main.typ": "= server" });
      expect(result.current.status.offline).toBe(false);
    });
  });

  it("uses a stale cache only after the server bootstrap fails", async () => {
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "project-a",
      entryFilePath: "main.typ",
      nodes: [{ path: "main.typ", kind: "file" }],
      docs: { "main.typ": "= stale cache" },
    });
    vi.mocked(loadWorkspaceBootstrap).mockRejectedValue(new Error("offline"));

    const { result } = renderWorkspaceSession({
      project: project(new Date(Date.now() + 60_000).toISOString()),
    });
    await waitFor(() => {
      expect(result.current.status.loaded).toBe(true);
      expect(result.current.projection.documents).toEqual({
        "main.typ": "= stale cache",
      });
      expect(result.current.projection.offlineMessage).toBe("cached-offline");
      expect(result.current.status.offline).toBe(true);
    });
  });

  it("resolves refresh only after the refreshed asset catalog is hydrated", async () => {
    const hydration = deferred<ProjectAssetContentResponse>();
    vi.mocked(getProjectAssetContentCached).mockReturnValue(hydration.promise);
    vi.mocked(loadWorkspaceBootstrap)
      .mockResolvedValueOnce(bootstrap("= initial"))
      .mockResolvedValueOnce(bootstrap("= refreshed", "document-a", true));
    const { result } = renderWorkspaceSession();
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({ "main.typ": "= initial" });
    });

    let refreshResolved = false;
    let refreshPromise: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.commands.refresh().then(() => {
        refreshResolved = true;
      });
      await waitFor(() => {
        expect(result.current.projection.documents).toEqual({
          "main.typ": "= refreshed",
        });
        expect(getProjectAssetContentCached).toHaveBeenCalledOnce();
      });
    });
    expect(refreshResolved).toBe(false);

    await act(async () => {
      hydration.resolve(assetResponse());
      await refreshPromise;
    });
    expect(refreshResolved).toBe(true);
  });

  it("does not apply a refresh that completes after switching projects", async () => {
    const staleRefresh = deferred<WorkspaceBootstrap>();
    let projectALoads = 0;
    vi.mocked(loadWorkspaceBootstrap).mockImplementation((input) => {
      if (input.projectId === "project-b") {
        return Promise.resolve(bootstrap("= project B", "document-b"));
      }
      projectALoads += 1;
      if (projectALoads === 1) {
        return Promise.resolve(bootstrap("= project A"));
      }
      return staleRefresh.promise;
    });
    const { result, rerender } = renderWorkspaceSession();
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({ "main.typ": "= project A" });
    });

    let refreshPromise: Promise<void>;
    act(() => {
      refreshPromise = result.current.commands.refresh();
    });
    await waitFor(() => expect(projectALoads).toBe(2));
    rerender({
      projectId: "project-b",
      currentProject: project("2026-07-12T00:00:00Z", "project-b"),
      accessSessionKey: "user-a",
      offlineCacheIdentity: "user-a",
    });
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({ "main.typ": "= project B" });
    });

    await act(async () => {
      staleRefresh.resolve(bootstrap("= stale project A"));
      await refreshPromise;
    });
    expect(result.current.projection.documents).toEqual({ "main.typ": "= project B" });
    expect(result.current.projection.offlineMessage).toBeNull();
  });

  it("rejects a bootstrap from an obsolete access session for the same project", async () => {
    const staleBootstrap = deferred<WorkspaceBootstrap>();
    let loadCount = 0;
    vi.mocked(loadWorkspaceBootstrap).mockImplementation(() => {
      loadCount += 1;
      return loadCount === 1
        ? staleBootstrap.promise
        : Promise.resolve(bootstrap("= current access"));
    });
    const { result, rerender } = renderWorkspaceSession({
      accessSessionKey: "share-a",
    });
    await waitFor(() => expect(loadWorkspaceBootstrap).toHaveBeenCalledOnce());

    rerender({
      projectId: "project-a",
      currentProject: project(),
      accessSessionKey: "share-b",
      offlineCacheIdentity: "user-a",
    });
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({
        "main.typ": "= current access",
      });
    });

    await act(async () => {
      staleBootstrap.resolve(bootstrap("= obsolete access"));
      await staleBootstrap.promise;
    });
    expect(result.current.projection.documents).toEqual({
      "main.typ": "= current access",
    });
  });

  it("retains a server projection when a later refresh fails", async () => {
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "project-a",
      entryFilePath: "main.typ",
      nodes: [{ path: "main.typ", kind: "file" }],
      docs: { "main.typ": "= stale cache" },
    });
    vi.mocked(loadWorkspaceBootstrap)
      .mockResolvedValueOnce(bootstrap("= current server"))
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = renderWorkspaceSession({
      project: project(new Date(Date.now() + 60_000).toISOString()),
    });
    await waitFor(() => {
      expect(result.current.projection.documents["main.typ"]).toBe(
        "= current server",
      );
    });

    await act(async () => {
      await result.current.commands.refresh();
    });

    expect(result.current.projection.documents["main.typ"]).toBe(
      "= current server",
    );
    expect(result.current.status.offline).toBe(true);
    expect(result.current.projection.offlineMessage).toBe("cached-offline");
  });

  it("does not expose an authenticated offline cache to a share session", async () => {
    saveProjectSnapshotToCache({
      cacheIdentity: "user-a",
      projectId: "project-a",
      entryFilePath: "main.typ",
      nodes: [{ path: "main.typ", kind: "file" }],
      docs: { "main.typ": "= private cache" },
    });
    const pending = deferred<WorkspaceBootstrap>();
    vi.mocked(loadWorkspaceBootstrap).mockReturnValue(pending.promise);

    const { result } = renderWorkspaceSession({
      accessSessionKey: "share-a",
      offlineCacheIdentity: null,
      project: project(new Date(Date.now() - 1000).toISOString()),
    });

    await waitFor(() => expect(loadWorkspaceBootstrap).toHaveBeenCalledOnce());
    expect(result.current.status.loaded).toBe(false);
    expect(result.current.projection.documents).toEqual({});

    await act(async () => {
      pending.resolve(bootstrap("= authorized share"));
      await pending.promise;
    });
    await waitFor(() => {
      expect(result.current.projection.documents).toEqual({
        "main.typ": "= authorized share",
      });
    });
  });
});
