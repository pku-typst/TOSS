// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { NavigateFunction } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setShareAccessContext,
  temporaryShareLogin
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { useWorkspaceGuestSession } from "@/pages/workspace/hooks/useWorkspaceGuestSession";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    setShareAccessContext: vi.fn(),
    temporaryShareLogin: vi.fn()
  };
});

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } }
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function renderGuestSession() {
  return renderHook(
    () =>
      useWorkspaceGuestSession({
        projectId: "project-a",
        authUser: null,
        shareToken: "share-a",
        navigate: vi.fn() as unknown as NavigateFunction,
        refreshProjects: vi.fn().mockResolvedValue(undefined),
        t: ((key: string) => key) as Translator
      }),
    { wrapper: createWrapper() }
  );
}

describe("useWorkspaceGuestSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(setShareAccessContext).mockReset();
    vi.mocked(temporaryShareLogin).mockReset();
  });

  it("validates a guest name without starting a server operation", async () => {
    const { result } = renderGuestSession();

    let accepted = true;
    await act(async () => {
      result.current.openAuthModal();
      accepted = await result.current.beginTemporaryGuestEditing();
    });

    expect(accepted).toBe(false);
    expect(result.current.guestAuthError).toBe("auth.username");
    expect(temporaryShareLogin).not.toHaveBeenCalled();
  });

  it("owns guest login pending, result, and persisted identity state", async () => {
    vi.mocked(temporaryShareLogin).mockResolvedValue({
      display_name: "Ada",
      permission: "write",
      project_id: "project-a",
      session_id: "session-a",
      session_token: "token-a"
    });
    const { result } = renderGuestSession();

    await act(async () => {
      result.current.openAuthModal();
      result.current.setGuestNameInput(" Ada ");
    });
    let accepted = false;
    await act(async () => {
      accepted = await result.current.beginTemporaryGuestEditing();
    });

    expect(accepted).toBe(true);
    expect(temporaryShareLogin).toHaveBeenCalledWith("share-a", "Ada");
    expect(result.current).toMatchObject({
      authModalOpen: false,
      guestAuthPending: false,
      guestSessionToken: "token-a",
      shareGuestSession: "token-a"
    });
    expect(window.localStorage.getItem("guest.display_name")).toBe("Ada");
    expect(window.localStorage.getItem("guest.share.project-a.session")).toBe(
      "token-a"
    );
    await waitFor(() => {
      expect(setShareAccessContext).toHaveBeenLastCalledWith({
        shareToken: "share-a",
        guestSession: "token-a"
      });
    });
  });

  it("projects the mutation failure into the dialog", async () => {
    vi.mocked(temporaryShareLogin).mockRejectedValue(
      new Error("guest login unavailable")
    );
    const { result } = renderGuestSession();

    await act(async () => {
      result.current.openAuthModal();
      result.current.setGuestNameInput("Ada");
    });
    await act(async () => {
      await result.current.beginTemporaryGuestEditing();
    });

    expect(result.current.guestAuthError).toBe("guest login unavailable");
    expect(result.current.guestAuthPending).toBe(false);
  });
});
