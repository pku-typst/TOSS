import { useQuery } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createProjectShareLink,
  deleteProjectOrganizationAccess,
  listProjectAccessUsers,
  listProjectOrganizationAccess,
  listProjectShareLinks,
  revokeProjectShareLink,
  updateProjectTemplate,
  upsertProjectOrganizationAccess,
  type ProjectPermission,
  type ProjectShareLink,
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

type UseWorkspaceAccessActionsInput = {
  projectId: string;
  sessionGeneration: string;
  projectIsTemplate: boolean;
  canManageProject: boolean;
  settingsPanelVisible: boolean;
  presenceMembershipKey: string;
  replaceShareLinks: (shareLinks: ProjectShareLink[]) => void;
  refreshProjects: () => Promise<void>;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useWorkspaceAccessActions(
  input: UseWorkspaceAccessActionsInput,
) {
  const {
    canManageProject,
    presenceMembershipKey,
    projectId,
    settingsPanelVisible,
  } = input;
  const copyNoticeTimerRef = useRef<number | null>(null);
  const [copiedControl, setCopiedControl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateEnabled, setTemplateEnabled] = useState(
    input.projectIsTemplate,
  );
  const accessQuery = useQuery({
    queryKey: [
      "project-access",
      input.sessionGeneration,
      presenceMembershipKey,
    ],
    queryFn: async () => {
      const [organizationAccess, accessUsers] = await Promise.all([
        listProjectOrganizationAccess(projectId),
        listProjectAccessUsers(projectId).then((response) => response.users),
      ]);
      return { organizationAccess, accessUsers };
    },
    enabled: !!projectId && canManageProject && settingsPanelVisible,
  });

  useEffect(() => {
    setTemplateEnabled(input.projectIsTemplate);
  }, [input.projectIsTemplate]);

  useEffect(
    () => () => {
      if (copyNoticeTimerRef.current !== null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
    },
    [],
  );

  async function refreshProjectAccessData() {
    if (!input.projectId || !input.canManageProject) return;
    await accessQuery.refetch();
  }

  async function createShare(permission: ProjectPermission) {
    if (!input.projectId || !input.canManageProject) return;
    try {
      await createProjectShareLink(input.projectId, { permission });
      const shareLinks = await listProjectShareLinks(input.projectId);
      input.replaceShareLinks(shareLinks);
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.createShare")),
      );
    }
  }

  async function revokeShare(shareLinkId: string) {
    if (!input.projectId || !input.canManageProject) return;
    try {
      await revokeProjectShareLink(input.projectId, shareLinkId);
      const shareLinks = await listProjectShareLinks(input.projectId);
      input.replaceShareLinks(shareLinks);
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.revokeShare")),
      );
    }
  }

  async function copyToClipboard(controlKey: string, value: string) {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedControl(controlKey);
      if (copyNoticeTimerRef.current !== null) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      copyNoticeTimerRef.current = window.setTimeout(() => {
        setCopiedControl((current) =>
          current === controlKey ? null : current,
        );
      }, 1600);
      setError(null);
    } catch {
      setError(input.t("errors.copyClipboard"));
    }
  }

  async function upsertOrganizationAccess(
    organizationId: string,
    permission: ProjectPermission,
  ) {
    if (!input.projectId || !input.canManageProject) return;
    try {
      await upsertProjectOrganizationAccess(
        input.projectId,
        organizationId,
        permission,
      );
      await refreshProjectAccessData();
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.updateOrganizationAccess")),
      );
    }
  }

  async function removeOrganizationAccess(organizationId: string) {
    if (!input.projectId || !input.canManageProject) return;
    try {
      await deleteProjectOrganizationAccess(input.projectId, organizationId);
      await refreshProjectAccessData();
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.removeOrganizationAccess")),
      );
    }
  }

  async function setTemplateState(next: boolean) {
    if (!input.projectId || !input.canManageProject) return;
    try {
      await updateProjectTemplate(input.projectId, next);
      setTemplateEnabled(next);
      await input.refreshProjects().catch(() => undefined);
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.updateTemplate")),
      );
    }
  }

  return {
    error:
      error ??
      (accessQuery.error
        ? errorMessage(accessQuery.error, input.t("errors.loadAccess"))
        : null),
    copiedControl,
    templateEnabled,
    organizationAccess: accessQuery.data?.organizationAccess ?? [],
    accessUsers: accessQuery.data?.accessUsers ?? [],
    createShare,
    revokeShare,
    copyToClipboard,
    upsertOrganizationAccess,
    removeOrganizationAccess,
    setTemplateState,
  };
}
