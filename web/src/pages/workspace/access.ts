import type {
  AnonymousMode,
  Project,
  ProjectAccessSource,
  ProjectAccessType,
  ProjectPermission,
  ProjectRole
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

type DeriveWorkspacePermissionsInput = {
  isAnonymousShare: boolean;
  sharePermission: ProjectPermission | null;
  anonymousMode?: AnonymousMode | null;
  project: Project | undefined;
  hasGuestSessionToken: boolean;
  hasAuthUser: boolean;
};

type WorkspacePermissions = {
  canRequestGuestWrite: boolean;
  canWrite: boolean;
  canManageProject: boolean;
  canViewWriteShareLink: boolean;
  canViewShareLinks: boolean;
};

export function deriveWorkspacePermissions(input: DeriveWorkspacePermissionsInput): WorkspacePermissions {
  const {
    isAnonymousShare,
    sharePermission,
    anonymousMode,
    project,
    hasGuestSessionToken,
    hasAuthUser
  } = input;
  const canRequestGuestWrite =
    isAnonymousShare &&
    !project?.is_template &&
    sharePermission === "write" &&
    anonymousMode === "read_write_named" &&
    !hasGuestSessionToken;
  const canWrite = hasAuthUser
    ? project?.my_role !== "ReadOnly"
    : !project?.is_template &&
      sharePermission === "write" &&
      anonymousMode === "read_write_named" &&
      hasGuestSessionToken;
  const canManageProject = hasAuthUser ? project?.my_role === "Owner" : false;
  const canViewWriteShareLink = hasAuthUser
    ? project?.my_role === "Owner" || project?.my_role === "ReadWrite"
    : false;
  const canViewShareLinks = hasAuthUser && !isAnonymousShare;
  return {
    canRequestGuestWrite,
    canWrite: !!canWrite,
    canManageProject: !!canManageProject,
    canViewWriteShareLink: !!canViewWriteShareLink,
    canViewShareLinks
  };
}

export function formatAccessType(accessType: ProjectAccessType, role: ProjectRole, t: Translator) {
  if (accessType === "manage") return t("settings.accessManage");
  if (accessType === "write") return t("settings.readWrite");
  if (accessType === "read") return t("settings.readOnly");
  return formatRoleLabel(role, t);
}

export function formatRoleLabel(role: ProjectRole, t: Translator) {
  if (role === "Owner") return t("settings.roleOwner");
  if (role === "ReadWrite") return t("settings.roleReadWrite");
  if (role === "ReadOnly") return t("settings.roleReadOnly");
  return t("common.unknown");
}

export function formatAccessSource(source: ProjectAccessSource, t: Translator) {
  if (source.kind === "share_link_invite") return t("settings.sourceShareLink");
  if (source.kind === "direct_role") return t("settings.sourceDirect");
  if (source.kind === "organization") {
    return t("settings.sourceOrganization", { name: source.name });
  }
  return t("common.unknown");
}
