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
  upsertProjectOrganizationAccess,
  type ProjectPermission,
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { useTemplateCatalog } from "@/templates/templateCatalog";

type UseWorkspaceAccessActionsInput = {
  projectId: string;
  sessionGeneration: string;
  projectIsTemplate: boolean;
  canManageProject: boolean;
  projectAccessEnabled: boolean;
  settingsPanelVisible: boolean;
  presenceMembershipKey: string;
  refreshProjects: () => Promise<void>;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useWorkspaceAccessActions(
  input: UseWorkspaceAccessActionsInput,
) {
  const templateCatalog = useTemplateCatalog();
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
      const [organizationAccess, accessUsers, shareLinks] = await Promise.all([
        listProjectOrganizationAccess(projectId),
        listProjectAccessUsers(projectId).then((response) => response.users),
        listProjectShareLinks(projectId),
      ]);
      return { organizationAccess, accessUsers, shareLinks };
    },
    enabled:
      input.projectAccessEnabled &&
      !!projectId &&
      canManageProject &&
      settingsPanelVisible,
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
    if (!input.projectAccessEnabled || !input.projectId || !input.canManageProject) return;
    await accessQuery.refetch();
  }

  async function createShare(permission: ProjectPermission) {
    if (!input.projectAccessEnabled || !input.projectId || !input.canManageProject) return;
    try {
      await createProjectShareLink(input.projectId, { permission });
      await refreshProjectAccessData();
      setError(null);
    } catch (error) {
      setError(
        errorMessage(error, input.t("errors.createShare")),
      );
    }
  }

  async function revokeShare(shareLinkId: string) {
    if (!input.projectAccessEnabled || !input.projectId || !input.canManageProject) return;
    try {
      await revokeProjectShareLink(input.projectId, shareLinkId);
      await refreshProjectAccessData();
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
    if (!input.projectAccessEnabled || !input.projectId || !input.canManageProject) return;
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
    if (!input.projectAccessEnabled || !input.projectId || !input.canManageProject) return;
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
      await templateCatalog.setProjectTemplate(input.projectId, next);
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
      (input.projectAccessEnabled && accessQuery.error
        ? errorMessage(accessQuery.error, input.t("errors.loadAccess"))
        : null),
    copiedControl,
    templateEnabled,
    organizationAccess: accessQuery.data?.organizationAccess ?? [],
    accessUsers: accessQuery.data?.accessUsers ?? [],
    shareLinks: accessQuery.data?.shareLinks ?? [],
    createShare,
    revokeShare,
    copyToClipboard,
    upsertOrganizationAccess,
    removeOrganizationAccess,
    setTemplateState,
  };
}
