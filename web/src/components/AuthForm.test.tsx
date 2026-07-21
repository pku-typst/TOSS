// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthForm } from "@/components/AuthForm";
import type { AuthConfig } from "@/lib/api";
import { translate } from "@/lib/i18n";

vi.mock("@/components/ui", () => ({
  UiButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  UiInput: ({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) => (
    <label>
      {label}
      <input {...props} />
    </label>
  )
}));

const baseConfig: AuthConfig = {
  accent_color: "#76b900",
  accent_text_color: "#000000",
  ai_assistant: null,
  allow_local_login: false,
  allow_local_registration: false,
  allow_oidc: true,
  announcement: "",
  anonymous_mode: "off",
  brand_mark: "T",
  client_id: null,
  distribution_id: "community",
  enabled_frontend_features: [],
  enabled_project_types: ["typst"],
  external_git_providers: [],
  groups_claim: "groups",
  identity_providers: [],
  issuer: null,
  redirect_uri: null,
  site_name: "Test",
  site_name_managed: true
};

const providers: AuthConfig["identity_providers"] = [
  {
    id: "external-git:github",
    display_name: "GitHub",
    brand: "github",
    kind: "github",
    protocol: "github_app",
    login_path: "/v1/auth/external-git/github/login"
  },
  {
    id: "external-git:gitlab",
    display_name: "GitLab",
    brand: "gitlab",
    kind: "gitlab",
    protocol: "oauth",
    login_path: "/v1/auth/external-git/gitlab/login"
  },
  {
    id: "external-git:gitea",
    display_name: "Gitea",
    brand: "gitea",
    kind: "gitea",
    protocol: "oauth",
    login_path: "/v1/auth/external-git/gitea/login"
  },
  {
    id: "external-git:codeberg",
    display_name: "Codeberg",
    brand: "codeberg",
    kind: "forgejo",
    protocol: "oauth",
    login_path: "/v1/auth/external-git/codeberg/login"
  },
  {
    id: "company-sso",
    display_name: "CompanySSO",
    brand: "identity",
    kind: null,
    protocol: "oidc",
    login_path: "/v1/auth/oidc/login"
  }
];

const t = (key: string, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("AuthForm", () => {
  it("renders a provider-only login without local-account controls", () => {
    render(
      <AuthForm
        config={{ ...baseConfig, identity_providers: providers }}
        t={t}
        onSignedIn={vi.fn()}
      />
    );

    expect(screen.getByRole("group", { name: t("auth.providersLabel") })).toBeTruthy();
    expect(screen.queryByLabelText(t("auth.email"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("auth.loginTab") })).toBeNull();
    expect(screen.queryByText(t("auth.orUseEmail"))).toBeNull();
  });

  it("separates provider choices from local login when both are enabled", () => {
    render(
      <AuthForm
        config={{
          ...baseConfig,
          allow_local_login: true,
          allow_local_registration: true,
          identity_providers: providers.slice(0, 2)
        }}
        t={t}
        onSignedIn={vi.fn()}
      />
    );

    expect(screen.getByRole("group", { name: t("auth.providersLabel") })).toBeTruthy();
    expect(screen.getByText(t("auth.orUseEmail"))).toBeTruthy();
    const modeSwitcher = screen.getByRole("group", { name: t("auth.emailAccount") });
    expect(within(modeSwitcher).getByRole("button", { name: t("auth.loginTab") })).toBeTruthy();
    expect(
      within(modeSwitcher).getByRole("button", { name: t("auth.registerTab") })
    ).toBeTruthy();
    expect(screen.getByLabelText(t("auth.email"))).toBeTruthy();
    expect(screen.getByLabelText(t("auth.password"))).toBeTruthy();

    fireEvent.click(within(modeSwitcher).getByRole("button", { name: t("auth.registerTab") }));
    expect(screen.getByLabelText(t("auth.username"))).toBeTruthy();
    expect(screen.getByLabelText(t("auth.displayNameOptional"))).toBeTruthy();
  });

  it("assigns stable presentation brands to known providers", () => {
    render(
      <AuthForm
        config={{ ...baseConfig, identity_providers: providers }}
        t={t}
        onSignedIn={vi.fn()}
      />
    );

    expect(
      screen
        .getByRole("button", { name: t("auth.providerLogin", { provider: "GitHub" }) })
        .getAttribute("data-provider-brand")
    ).toBe("github");
    expect(
      screen
        .getByRole("button", { name: t("auth.providerLogin", { provider: "GitLab" }) })
        .getAttribute("data-provider-brand")
    ).toBe("gitlab");
    expect(
      screen
        .getByRole("button", { name: t("auth.providerLogin", { provider: "Gitea" }) })
        .getAttribute("data-provider-brand")
    ).toBe("gitea");
    expect(
      screen
        .getByRole("button", { name: t("auth.providerLogin", { provider: "Codeberg" }) })
        .getAttribute("data-provider-brand")
    ).toBe("codeberg");
    expect(
      screen
        .getByRole("button", { name: t("auth.providerLogin", { provider: "CompanySSO" }) })
        .getAttribute("data-provider-brand")
    ).toBe("identity");
  });

  it("prevents retrying the unbound provider during existing-account verification", () => {
    render(
      <AuthForm
        config={{ ...baseConfig, identity_providers: providers.slice(0, 2) }}
        disabledIdentityProviderId="external-git:gitlab"
        t={t}
        onSignedIn={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: t("auth.providerLogin", { provider: "GitLab" })
      }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("button", {
        name: t("auth.providerLogin", { provider: "GitHub" })
      }).hasAttribute("disabled")
    ).toBe(false);
  });
});
