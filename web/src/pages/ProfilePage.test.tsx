// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectExternalGitConnection,
  getExternalGitConnectionStatus,
  listPersonalAccessTokens,
  type ExternalGitConnectionStatus,
  type ExternalGitProvider
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { ProfilePage } from "@/pages/ProfilePage";

vi.mock("@/components/ui", () => ({
  UiBadge: ({ children }: PropsWithChildren) => <span>{children}</span>,
  UiButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  UiCard: ({ children }: PropsWithChildren) => <section>{children}</section>,
  UiDialog: ({
    open,
    children,
    actions
  }: PropsWithChildren<{ open: boolean; actions?: ReactNode }>) =>
    open ? (
      <div role="dialog">
        {children}
        {actions}
      </div>
    ) : null,
  UiEmptyState: ({ description }: { description?: ReactNode }) => <div>{description}</div>,
  UiHelpTooltip: () => null,
  UiIconButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  UiInput: ({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
  UiPageHeading: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
  UiSectionHeading: ({
    title,
    description,
    actions
  }: {
    title: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      {description}
      {actions}
    </div>
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
  ),
  UiTooltip: ({ children }: PropsWithChildren) => <>{children}</>
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    createPersonalAccessToken: vi.fn(),
    disconnectExternalGitConnection: vi.fn(),
    getExternalGitConnectionStatus: vi.fn(),
    listPersonalAccessTokens: vi.fn(),
    revokePersonalAccessToken: vi.fn()
  };
});

const provider: ExternalGitProvider = {
  authorization_path: "/v1/external-git/providers/codeberg/authorize",
  base_url: "https://codeberg.org",
  brand: "codeberg",
  capabilities: {
    repository_creation: true,
    supported_visibilities: ["private", "public"]
  },
  display_name: "Codeberg",
  id: "codeberg",
  kind: "forgejo"
};

function connection(
  restriction: ExternalGitConnectionStatus["disconnect_restriction"]
): ExternalGitConnectionStatus {
  return {
    account_id: "account-1",
    base_url: provider.base_url,
    bound: true,
    can_disconnect: restriction === null,
    configured: true,
    connected: true,
    disconnect_restriction: restriction,
    expires_at: null,
    provider: provider.id,
    provider_name: provider.display_name,
    scopes: [],
    status: "active",
    username: "alice"
  };
}

const t: Translator = (key) => key;

function renderProfile() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <MemoryRouter initialEntries={["/profile"]}>
      <QueryClientProvider client={queryClient}>
        <ProfilePage externalGitProviders={[provider]} locale="en" t={t} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProfilePage", () => {
  it("does not allow the last provider login method to be disconnected", async () => {
    vi.mocked(getExternalGitConnectionStatus).mockResolvedValue(
      connection("last_login_method")
    );
    vi.mocked(listPersonalAccessTokens).mockResolvedValue({ tokens: [] });

    renderProfile();

    const button = await screen.findByRole("button", {
      name: "profile.externalGitDisconnect"
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(
        "profile.externalGitDisconnectRestriction.last_login_method"
      )
    ).toBeTruthy();
  });

  it("disconnects a provider when another login method remains", async () => {
    vi.mocked(getExternalGitConnectionStatus).mockResolvedValue(connection(null));
    vi.mocked(listPersonalAccessTokens).mockResolvedValue({ tokens: [] });
    vi.mocked(disconnectExternalGitConnection).mockResolvedValue(undefined);

    renderProfile();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "profile.externalGitDisconnect"
      })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "profile.externalGitDisconnect"
      })
    );
    await waitFor(() => {
      expect(vi.mocked(disconnectExternalGitConnection).mock.calls[0]?.[0]).toBe(
        "codeberg"
      );
    });
    expect(dialog).toBeTruthy();
  });
});
