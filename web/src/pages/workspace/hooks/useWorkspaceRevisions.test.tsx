// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRevision,
  getRevisionDocuments,
  listRevisions,
  type Revision
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { useWorkspaceRevisions } from "@/pages/workspace/hooks/useWorkspaceRevisions";

vi.mock("@/lib/api", () => ({
  createRevision: vi.fn(),
  getRevisionDocuments: vi.fn(),
  listRevisions: vi.fn()
}));

function revision(id: string): Revision {
  return {
    actor_user_id: null,
    authors: [],
    created_at: "2026-07-12T00:00:00Z",
    id,
    project_id: "project-a",
    summary: id
  };
}

const t: Translator = (key) => key;

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

async function flushQueries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useWorkspaceRevisions", () => {
  it("queries only a visible head and never re-polls loaded history pages", async () => {
    vi.useFakeTimers();
    let headRequestCount = 0;
    vi.mocked(listRevisions).mockImplementation((_projectId, options) => {
      if (options?.before) {
        return Promise.resolve({ revisions: [revision("revision-40")] });
      }
      headRequestCount += 1;
      const head = Array.from({ length: 40 }, (_value, index) =>
        revision(`revision-${index}`)
      );
      return Promise.resolve({
        revisions:
          headRequestCount === 1
            ? head
            : [revision("revision-new"), ...head.slice(0, 39)]
      });
    });
    vi.mocked(getRevisionDocuments).mockRejectedValue(
      new Error("not-requested")
    );
    const { result, rerender } = renderHook(
      ({ visible }) =>
        useWorkspaceRevisions({
          projectId: "project-a",
          sessionGeneration: "session-a",
          workspaceLoaded: true,
          enabled: true,
          visible,
          projectType: "typst",
          liveDocs: {},
          liveAssets: {},
          liveAssetMeta: {},
          t
        }),
      { initialProps: { visible: false }, wrapper: wrapper() }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(listRevisions).not.toHaveBeenCalled();

    rerender({ visible: true });
    await flushQueries();
    expect(listRevisions).toHaveBeenCalledTimes(1);
    expect(listRevisions).toHaveBeenLastCalledWith("project-a", {
      limit: 40
    });
    expect(result.current.revisions).toHaveLength(40);

    act(() => result.current.loadMore());
    await flushQueries();
    expect(listRevisions).toHaveBeenCalledTimes(2);
    expect(listRevisions).toHaveBeenLastCalledWith("project-a", {
      before: "revision-39",
      limit: 40
    });
    expect(result.current.revisions.at(-1)?.id).toBe("revision-40");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listRevisions).toHaveBeenCalledTimes(3);
    expect(listRevisions).toHaveBeenLastCalledWith("project-a", {
      limit: 40
    });
    expect(result.current.revisions.map((item) => item.id)).toContain(
      "revision-39"
    );
    expect(result.current.revisions.map((item) => item.id)).toContain(
      "revision-40"
    );
  });

  it("creates a named revision and prepends it without another list request", async () => {
    vi.mocked(listRevisions).mockResolvedValue({ revisions: [] });
    const created = {
      ...revision("revision-manual"),
      summary: "snapshot fixture"
    };
    vi.mocked(createRevision).mockResolvedValue(created);
    const { result } = renderHook(
      () =>
        useWorkspaceRevisions({
          projectId: "project-a",
          sessionGeneration: "session-a",
          workspaceLoaded: true,
          enabled: true,
          visible: true,
          projectType: "typst",
          liveDocs: {},
          liveAssets: {},
          liveAssetMeta: {},
          t
        }),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(listRevisions).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.createRevision("  snapshot fixture  ");
    });

    expect(createRevision).toHaveBeenCalledWith("project-a", "snapshot fixture");
    expect(listRevisions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.revisions).toEqual([created]));
  });

  it("propagates creation failures to the snapshot dialog", async () => {
    vi.mocked(listRevisions).mockResolvedValue({ revisions: [] });
    vi.mocked(createRevision).mockRejectedValue(new Error("snapshot failed"));
    const { result } = renderHook(
      () =>
        useWorkspaceRevisions({
          projectId: "project-a",
          sessionGeneration: "session-a",
          workspaceLoaded: true,
          enabled: true,
          visible: true,
          projectType: "typst",
          liveDocs: {},
          liveAssets: {},
          liveAssetMeta: {},
          t
        }),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(listRevisions).toHaveBeenCalledTimes(1));
    await expect(
      result.current.createRevision("snapshot fixture")
    ).rejects.toThrow("snapshot failed");

    expect(result.current.revisions).toEqual([]);
  });
});
