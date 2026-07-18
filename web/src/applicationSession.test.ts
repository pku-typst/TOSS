import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canAccessAdminPanel,
  getAuthConfig,
  getAuthMe,
  getExperience,
  listMyOrganizations,
  listProjects,
  type AuthConfig,
  type AuthUser,
  type Experience
} from "@/lib/api";
import {
  applicationBootstrapQueryKey,
  clearSessionQueryCaches,
  loadApplicationBootstrap,
  loadSignedInContext
} from "@/applicationSession";
import type { ProjectCatalog } from "@/projects/projectCatalog";

vi.mock("@/lib/api", () => ({
  canAccessAdminPanel: vi.fn(),
  getAuthConfig: vi.fn(),
  getAuthMe: vi.fn(),
  getExperience: vi.fn(),
  listMyOrganizations: vi.fn(),
  listProjects: vi.fn()
}));

const authConfig: AuthConfig = {
  accent_color: "#76b900",
  accent_text_color: "#000000",
  ai_assistant: null,
  allow_local_login: false,
  allow_local_registration: false,
  allow_oidc: true,
  announcement: "",
  anonymous_mode: "off",
  brand_mark: "N",
  client_id: "client-a",
  distribution_id: "community",
  enabled_frontend_features: [],
  enabled_project_types: ["typst"],
  external_git_providers: [],
  groups_claim: "groups",
  identity_providers: [],
  issuer: "https://identity.example.test",
  redirect_uri: "https://typst.example.test/callback",
  site_name: "typst-collab",
  site_name_managed: true
};

const experience: Experience = {
  distribution_id: "community",
  landing: {
    headline: { en: "headline", "zh-CN": "headline" },
    highlights: [],
    summary: { en: "summary", "zh-CN": "summary" }
  },
  product: {
    accent_color: "#76b900",
    accent_text_color: "#000000",
    brand_mark: "N",
    description: { en: "description", "zh-CN": "description" },
    name: "typst-collab"
  },
  resources: []
};

const authUser: AuthUser = {
  display_name: "user-a",
  email: "user-a@example.test",
  session_expires_at: "2026-07-13T00:00:00Z",
  user_id: "user-a",
  username: "user-a"
};

const projectCatalog: ProjectCatalog = {
  list: (query) => listProjects(query),
  create: vi.fn(),
  copy: vi.fn(),
  rename: vi.fn(),
  setArchived: vi.fn(),
  loadThumbnail: vi.fn(),
  saveThumbnail: vi.fn(),
};

describe("application session projections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads public configuration, experience, and session atomically", async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(authConfig);
    vi.mocked(getExperience).mockResolvedValue(experience);
    vi.mocked(getAuthMe).mockResolvedValue(authUser);

    await expect(loadApplicationBootstrap()).resolves.toEqual({
      authConfig,
      experience,
      authUser
    });
  });

  it("keeps the signed-in projection available when the admin check fails", async () => {
    vi.mocked(listProjects).mockResolvedValue({ projects: [] });
    vi.mocked(listMyOrganizations).mockResolvedValue({ organizations: [] });
    vi.mocked(canAccessAdminPanel).mockRejectedValue(new Error("forbidden"));

    await expect(loadSignedInContext(projectCatalog)).resolves.toEqual({
      projects: [],
      organizations: [],
      hasAdminAccess: false
    });
  });

  it("clears session-scoped queries and mutations but preserves bootstrap", () => {
    const client = new QueryClient();
    client.setQueryData(applicationBootstrapQueryKey, {
      authConfig,
      experience,
      authUser
    });
    client.setQueryData(["projects", "user-a"], ["project-a"]);
    client.getMutationCache().build(client, {
      mutationFn: async () => "done"
    });

    clearSessionQueryCaches(client);

    expect(client.getQueryData(applicationBootstrapQueryKey)).toBeDefined();
    expect(client.getQueryData(["projects", "user-a"])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
});
