// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listProjectAccessUsers,
  listProjectOrganizationAccess,
  type ProjectAccessUser,
  type ProjectOrganizationAccess,
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { useWorkspaceAccessActions } from "@/pages/workspace/hooks/useWorkspaceAccessActions";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    listProjectAccessUsers: vi.fn(),
    listProjectOrganizationAccess: vi.fn(),
  };
});

const t: Translator = (key) => key;

function organizationAccess(name: string): ProjectOrganizationAccess {
  return {
    granted_at: "2026-07-12T00:00:00Z",
    granted_by: null,
    organization_id: `organization-${name}`,
    organization_name: name,
    permission: "read",
    project_id: "project-a",
  };
}

function accessUser(name: string): ProjectAccessUser {
  return {
    access_type: "read",
    display_name: name,
    email: `${name}@example.test`,
    role: "ReadOnly",
    sources: [{ kind: "direct_role" }],
    user_id: `user-${name}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function renderAccessActions(sessionGeneration = "session-a") {
  return renderHook(
    ({ generation }: { generation: string }) =>
      useWorkspaceAccessActions({
        projectId: "project-a",
        sessionGeneration: generation,
        projectIsTemplate: false,
        canManageProject: true,
        settingsPanelVisible: true,
        presenceMembershipKey: "members-a",
        replaceShareLinks: vi.fn(),
        refreshProjects: vi.fn().mockResolvedValue(undefined),
        t,
      }),
    {
      initialProps: { generation: sessionGeneration },
      wrapper: wrapper(),
    },
  );
}

describe("useWorkspaceAccessActions", () => {
  beforeEach(() => {
    vi.mocked(listProjectAccessUsers).mockReset();
    vi.mocked(listProjectOrganizationAccess).mockReset();
  });

  it("does not carry access data across Workspace session generations", async () => {
    const nextOrganizations = deferred<ProjectOrganizationAccess[]>();
    const nextUsers = deferred<{ users: ProjectAccessUser[] }>();
    vi.mocked(listProjectOrganizationAccess)
      .mockResolvedValueOnce([organizationAccess("old")])
      .mockReturnValueOnce(nextOrganizations.promise);
    vi.mocked(listProjectAccessUsers)
      .mockResolvedValueOnce({ users: [accessUser("old")] })
      .mockReturnValueOnce(nextUsers.promise);

    const { result, rerender } = renderAccessActions();
    await waitFor(() => {
      expect(result.current.organizationAccess).toHaveLength(1);
      expect(result.current.accessUsers).toHaveLength(1);
    });

    rerender({ generation: "session-b" });
    expect(result.current.organizationAccess).toEqual([]);
    expect(result.current.accessUsers).toEqual([]);

    nextOrganizations.resolve([organizationAccess("new")]);
    nextUsers.resolve({ users: [accessUser("new")] });
    await waitFor(() => {
      expect(result.current.organizationAccess[0]?.organization_name).toBe(
        "new",
      );
      expect(result.current.accessUsers[0]?.display_name).toBe("new");
    });
  });

  it("reports access-query failures instead of presenting an empty grant set", async () => {
    vi.mocked(listProjectOrganizationAccess).mockRejectedValue(
      new Error("access backend unavailable"),
    );
    vi.mocked(listProjectAccessUsers).mockResolvedValue({ users: [] });

    const { result } = renderAccessActions();
    await waitFor(() => {
      expect(result.current.error).toBe("access backend unavailable");
    });
    expect(result.current.organizationAccess).toEqual([]);
    expect(result.current.accessUsers).toEqual([]);
  });
});
