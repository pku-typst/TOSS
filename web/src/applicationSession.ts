import type { QueryClient } from "@tanstack/react-query";
import {
  canAccessAdminPanel,
  getAuthConfig,
  getAuthMe,
  getExperience,
  listMyOrganizations,
  listProjects,
  type AuthConfig,
  type AuthUser,
  type Experience,
  type OrganizationMembership,
  type Project
} from "@/lib/api";

export const applicationBootstrapQueryKey = ["app-bootstrap"] as const;

export type ApplicationBootstrap = {
  authConfig: AuthConfig;
  experience: Experience;
  authUser: AuthUser | null;
};

export type SignedInContext = {
  projects: Project[];
  organizations: OrganizationMembership[];
  hasAdminAccess: boolean;
};

export function signedInContextQueryKey(userId: string) {
  return ["signed-in-context", userId] as const;
}

export async function loadApplicationBootstrap(): Promise<ApplicationBootstrap> {
  const [authConfig, experience, authUser] = await Promise.all([
    getAuthConfig(),
    getExperience(),
    getAuthMe()
  ]);
  return { authConfig, experience, authUser };
}

export async function loadSignedInContext(): Promise<SignedInContext> {
  const [projects, organizations, hasAdminAccess] = await Promise.all([
    listProjects({ includeArchived: true }),
    listMyOrganizations(),
    canAccessAdminPanel().catch(() => false)
  ]);
  return {
    projects: projects.projects,
    organizations: organizations.organizations,
    hasAdminAccess
  };
}

export function clearSessionQueryCaches(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] !== applicationBootstrapQueryKey[0]
  });
  queryClient.getMutationCache().clear();
}
