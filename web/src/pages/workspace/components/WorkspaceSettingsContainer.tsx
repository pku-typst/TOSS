import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getGitRepoLink,
  type AuthConfig,
  type OrganizationMembership,
  type Project,
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import {
  formatAccessSource,
  formatAccessType,
  formatRoleLabel,
} from "@/pages/workspace/access";
import { SettingsPanel } from "@/pages/workspace/components/SettingsPanel";
import { useWorkspaceAccessActions } from "@/pages/workspace/hooks/useWorkspaceAccessActions";
import { defaultEntryForProjectType } from "@/pages/workspace/loaders";
import type {
  WorkspaceSessionActor,
  WorkspaceSessionContext,
} from "@/pages/workspace/workspaceSessionActor";
import type {
  WorkspaceOptionalSettingsSectionDescriptor,
  WorkspaceSettingsSectionId,
} from "@/pages/workspace/types";
import { useWorkspaceBackend } from "@/workspace/workspaceBackend";

type WorkspaceSettingsContainerProps = {
  width: number;
  project: Project;
  organizations: OrganizationMembership[];
  authConfig: AuthConfig | null;
  permissions: {
    canManageProject: boolean;
    canViewWriteShareLink: boolean;
  };
  projectAccessEnabled: boolean;
  externalRepositoriesEnabled: boolean;
  preview: {
    renderer: "pdf" | "canvas";
    setRenderer: (renderer: "pdf" | "canvas") => void;
  };
  presenceMembershipKey: string;
  projection: WorkspaceSessionContext;
  sessionActor: WorkspaceSessionActor;
  refreshProjects: () => Promise<void>;
  optionalSections?: readonly WorkspaceOptionalSettingsSectionDescriptor[];
  preferredSection?: WorkspaceSettingsSectionId | null;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function WorkspaceSettingsContainer({
  width,
  project,
  organizations,
  authConfig,
  permissions,
  projectAccessEnabled,
  externalRepositoriesEnabled,
  preview,
  presenceMembershipKey,
  projection,
  sessionActor,
  refreshProjects,
  optionalSections,
  preferredSection,
  t,
}: WorkspaceSettingsContainerProps) {
  const workspaceBackend = useWorkspaceBackend();
  const {
    error: accessError,
    copiedControl,
    templateEnabled,
    organizationAccess: projectOrgAccess,
    accessUsers: projectAccessUsers,
    shareLinks: projectShareLinks,
    createShare,
    revokeShare,
    copyToClipboard,
    upsertOrganizationAccess: upsertOrgAccessGrant,
    removeOrganizationAccess: removeOrgAccessGrant,
    setTemplateState,
  } = useWorkspaceAccessActions({
    projectId: project.id,
    sessionGeneration: projection.scope.generation,
    projectIsTemplate: project.is_template,
    canManageProject: permissions.canManageProject,
    projectAccessEnabled,
    settingsPanelVisible: true,
    presenceMembershipKey,
    refreshProjects,
    t,
  });
  const gitRepoQuery = useQuery({
    queryKey: ["project-git-access", projection.scope.generation],
    queryFn: () => getGitRepoLink(project.id),
    enabled:
      externalRepositoriesEnabled && permissions.canManageProject,
    retry: false,
  });
  const entryFileMutation = useMutation({
    mutationFn: (operation: {
      generation: string;
      entryFilePath: string;
    }) =>
      workspaceBackend.updateEntryFile(project.id, {
        entry_file_path: operation.entryFilePath,
      }),
    onSuccess: (updated, operation) => {
      sessionActor.send({
        type: "settings.synchronized",
        generation: operation.generation,
        projectType: updated.project_type,
        latexEngine: updated.latex_engine ?? "xetex",
        entryFilePath: updated.entry_file_path,
        settingsRevision: updated.settings_revision,
      });
    },
  });
  const latexEngineMutation = useMutation({
    mutationFn: (operation: {
      generation: string;
      latexEngine: "pdftex" | "xetex";
    }) =>
      workspaceBackend.updateLatexEngine(project.id, {
        latex_engine: operation.latexEngine,
      }),
    onSuccess: (updated, operation) => {
      sessionActor.send({
        type: "settings.synchronized",
        generation: operation.generation,
        projectType: updated.project_type,
        latexEngine: updated.latex_engine ?? operation.latexEngine,
        entryFilePath: updated.entry_file_path,
        settingsRevision: updated.settings_revision,
      });
    },
  });
  const typEntryOptions = useMemo(() => {
    const pattern = projection.projectType === "latex" ? /\.(tex|ltx)$/i : /\.typ$/i;
    const values = new Set<string>();
    for (const path of Object.keys(projection.documents)) {
      if (pattern.test(path)) values.add(path);
    }
    for (const node of projection.nodes) {
      if (node.kind === "file" && pattern.test(node.path)) values.add(node.path);
    }
    if (pattern.test(projection.entryFilePath)) {
      values.add(projection.entryFilePath);
    }
    if (values.size === 0) {
      values.add(defaultEntryForProjectType(projection.projectType));
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [
    projection.documents,
    projection.entryFilePath,
    projection.nodes,
    projection.projectType,
  ]);
  const activeReadShare =
    projectShareLinks.find(
      (link) => link.permission === "read" && !link.revoked_at,
    ) ?? null;
  const activeWriteShare =
    projectShareLinks.find(
      (link) => link.permission === "write" && !link.revoked_at,
    ) ?? null;

  const mutateEntryFile = async (entryFilePath: string) => {
    await entryFileMutation.mutateAsync({
      generation: projection.scope.generation,
      entryFilePath,
    }).catch(() => undefined);
  };
  const mutateLatexEngine = async (latexEngine: "pdftex" | "xetex") => {
    await latexEngineMutation.mutateAsync({
      generation: projection.scope.generation,
      latexEngine,
    }).catch(() => undefined);
  };
  const settingsMutationError = entryFileMutation.error ?? latexEngineMutation.error;
  const settingsError = settingsMutationError
    ? errorMessage(settingsMutationError, t("errors.updateSettings"))
    : null;

  return (
    <SettingsPanel
      width={width}
      projectId={project.id}
      projectName={project.name || "typst-project"}
      projectType={projection.projectType}
      typstPreviewRenderer={preview.renderer}
      latexEngine={projection.latexEngine}
      entryFilePath={projection.entryFilePath}
      typEntryOptions={typEntryOptions}
      canManageProject={permissions.canManageProject}
      canViewWriteShareLink={permissions.canViewWriteShareLink}
      projectAccessEnabled={projectAccessEnabled}
      externalRepositoriesEnabled={externalRepositoriesEnabled}
      externalGitProviders={authConfig?.external_git_providers ?? []}
      gitRepoUrl={gitRepoQuery.data?.repo_url ?? ""}
      copiedControl={copiedControl}
      templateEnabled={templateEnabled}
      myOrganizations={organizations}
      projectOrgAccess={projectOrgAccess}
      projectAccessUsers={projectAccessUsers}
      error={settingsError ?? accessError}
      entryFilePending={entryFileMutation.isPending}
      latexEnginePending={latexEngineMutation.isPending}
      onEntryFileChange={mutateEntryFile}
      onLatexEngineChange={mutateLatexEngine}
      onTypstPreviewRendererChange={preview.setRenderer}
      onCopyToClipboard={copyToClipboard}
      onToggleTemplate={() => setTemplateState(!templateEnabled)}
      activeReadShare={activeReadShare}
      activeWriteShare={activeWriteShare}
      onCreateShare={createShare}
      onRevokeShare={revokeShare}
      onGrantOrgAccess={upsertOrgAccessGrant}
      onRevokeOrgAccess={removeOrgAccessGrant}
      formatAccessType={(accessType, role) =>
        formatAccessType(accessType, role, t)
      }
      formatRoleLabel={(role) => formatRoleLabel(role, t)}
      formatAccessSource={(source) => formatAccessSource(source, t)}
      optionalSections={optionalSections}
      preferredSection={preferredSection}
      t={t}
    />
  );
}
