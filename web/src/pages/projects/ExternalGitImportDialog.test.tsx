// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExternalGitImport,
  getExternalGitConnectionStatus,
  getExternalGitInboundJob,
  listExternalGitRepositories,
  listExternalGitRepositoryBranches,
  type ExternalGitConnectionStatus,
  type ExternalGitInboundJob,
  type ExternalGitProvider,
  type RemoteBranch,
  type RemoteRepository
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { ExternalGitImportDialog } from "@/pages/projects/ExternalGitImportDialog";

vi.mock("@/components/ui", () => ({
  UiButton: ({
    children,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
  UiDialog: ({
    open,
    children,
    actions
  }: PropsWithChildren<{ open: boolean; actions?: ReactNode }>) =>
    open ? (
      <div>
        {children}
        {actions}
      </div>
    ) : null,
  UiInput: ({
    label,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
  UiSelect: ({
    label,
    children,
    ...props
  }: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <select {...props}>{children}</select>
    </label>
  )
}));

vi.mock("@/lib/api", () => ({
  createExternalGitImport: vi.fn(),
  getExternalGitConnectionStatus: vi.fn(),
  getExternalGitInboundJob: vi.fn(),
  identityLoginUrl: vi.fn(() => "/authorize"),
  listExternalGitRepositories: vi.fn(),
  listExternalGitRepositoryBranches: vi.fn()
}));

const connection: ExternalGitConnectionStatus = {
  account_id: "account-a",
  base_url: "https://git.example.test",
  bound: true,
  can_disconnect: true,
  configured: true,
  connected: true,
  disconnect_restriction: null,
  expires_at: null,
  provider: "gitlab",
  provider_name: "gitlab",
  scopes: ["api"],
  status: "active",
  username: "user-a"
};

const repository: RemoteRepository = {
  archived: false,
  default_branch: "main",
  full_path: "group/slides",
  id: "repository-a",
  name: "slides",
  path: "slides",
  visibility: "private",
  web_url: "https://git.example.test/group/slides"
};

const branch: RemoteBranch = {
  commit_sha: "abc123",
  committed_at: null,
  default: true,
  name: "main",
  protected: false
};

function job(state: ExternalGitInboundJob["state"]): ExternalGitInboundJob {
  return {
    attempt_count: 0,
    completed_at: state === "succeeded" ? "2026-07-12T00:00:01Z" : null,
    created_at: new Date().toISOString(),
    id: "job-a",
    last_error: null,
    next_retry_at: null,
    operation: "import",
    phase: state === "succeeded" ? "complete" : "queued",
    project_id: "project-a",
    provider: "gitlab",
    remote_sha: "abc123",
    source_branch: "main",
    state,
    updated_at: "2026-07-12T00:00:00Z"
  };
}

const provider: ExternalGitProvider = {
  authorization_path: "/v1/external-git/providers/gitlab/authorize",
  base_url: "https://git.example.test",
  brand: "gitlab",
  capabilities: {
    repository_creation: true,
    supported_visibilities: ["private", "internal", "public"]
  },
  display_name: "gitlab",
  id: "gitlab",
  kind: "gitlab"
};

const t: Translator = (key) => key;

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return function QueryWrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ExternalGitImportDialog", () => {
  it("lets an unbound user select one configured provider before authorization", async () => {
    vi.mocked(getExternalGitConnectionStatus).mockResolvedValue({
      ...connection,
      account_id: null,
      base_url: "https://git.example.test",
      bound: false,
      can_disconnect: false,
      connected: false,
      disconnect_restriction: null,
      provider: "gitlab",
      provider_name: "gitlab",
      scopes: [],
      status: null,
      username: null
    });
    const github: ExternalGitProvider = {
      ...provider,
      authorization_path: "/v1/external-git/providers/github/authorize",
      base_url: "https://github.com",
      brand: "github",
      display_name: "GitHub",
      id: "github",
      kind: "github"
    };

    render(
      <ExternalGitImportDialog
        open
        providers={[provider, github]}
        enabledProjectTypes={["typst"]}
        onClose={vi.fn()}
        onComplete={vi.fn()}
        t={t}
      />,
      { wrapper: wrapper() }
    );

    const selector = await screen.findByLabelText("externalGit.providerSelect");
    expect((selector as HTMLSelectElement).value).toBe("gitlab");
    expect(
      document
        .querySelector(".external-git-provider-shell")
        ?.getAttribute("data-provider-brand")
    ).toBe("gitlab");
    fireEvent.change(selector, { target: { value: "github" } });
    expect((selector as HTMLSelectElement).value).toBe("github");
    expect(
      document
        .querySelector(".external-git-provider-shell")
        ?.getAttribute("data-provider-brand")
    ).toBe("github");
    expect(document.querySelector('[data-provider-logo="github"]')).not.toBeNull();
  });

  it("polls a live import and completes exactly once at a terminal state", async () => {
    vi.mocked(getExternalGitConnectionStatus).mockResolvedValue(connection);
    vi.mocked(listExternalGitRepositories).mockResolvedValue({
      next_page: null,
      repositories: [repository]
    });
    vi.mocked(listExternalGitRepositoryBranches).mockResolvedValue({
      branches: [branch],
      next_page: null
    });
    vi.mocked(createExternalGitImport).mockResolvedValue(job("pending"));
    vi.mocked(getExternalGitInboundJob).mockResolvedValue(job("succeeded"));
    const onComplete = vi.fn().mockResolvedValue(undefined);

    render(
      <ExternalGitImportDialog
        open
        providers={[provider]}
        enabledProjectTypes={["typst"]}
        onClose={vi.fn()}
        onComplete={onComplete}
        t={t}
      />,
      { wrapper: wrapper() }
    );

    await waitFor(() => {
      expect(
        (screen.getByLabelText("projects.namePlaceholder") as HTMLInputElement)
          .value
      ).toBe("slides");
    });
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: "externalGit.importAction" })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(createExternalGitImport).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getExternalGitInboundJob).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("project-a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getExternalGitInboundJob).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
