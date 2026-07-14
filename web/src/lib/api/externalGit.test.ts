import { describe, expect, it } from "vitest";
import { externalGitAuthorizationUrl } from "@/lib/api/externalGit";
import type { ExternalGitProvider } from "@/lib/api/types";

const githubProvider: ExternalGitProvider = {
  authorization_path: "/v1/external-git/providers/github/authorize",
  base_url: "https://github.com",
  brand: "github",
  capabilities: {
    repository_creation: false,
    supported_visibilities: ["private", "public"]
  },
  display_name: "GitHub",
  id: "github",
  kind: "github"
};

describe("external Git authorization URL", () => {
  it("preserves a same-origin return path for separate provider authorization", () => {
    expect(
      externalGitAuthorizationUrl(githubProvider, "/projects?import=github")
    ).toBe(
      "/v1/external-git/providers/github/authorize?return_to=%2Fprojects%3Fimport%3Dgithub"
    );
  });

  it("does not accept protocol-relative return targets", () => {
    expect(externalGitAuthorizationUrl(githubProvider, "//example.test")).toBe(
      "/v1/external-git/providers/github/authorize"
    );
  });

  it("does not construct a URL outside the external Git API namespace", () => {
    expect(
      externalGitAuthorizationUrl(
        { ...githubProvider, authorization_path: "/v1/auth/oidc" },
        "/projects"
      )
    ).toBeNull();
  });
});
