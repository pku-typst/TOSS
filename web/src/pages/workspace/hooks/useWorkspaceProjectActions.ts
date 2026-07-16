import { useCallback, useEffect, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
  copyProject,
  renameProject,
  type AuthUser,
  type Project
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import type { ProjectCopyDialogState } from "@/types/project-ui";

type UseWorkspaceProjectActionsInput = {
  projectId: string;
  sessionGeneration: string;
  project: Project | undefined;
  authUser: AuthUser | null;
  navigate: NavigateFunction;
  refreshProjects: () => Promise<void>;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useWorkspaceProjectActions(
  input: UseWorkspaceProjectActionsInput
) {
  const {
    projectId,
    sessionGeneration,
    project,
    authUser,
    navigate,
    refreshProjects,
    t
  } = input;
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(
    null
  );
  const [copyBusy, setCopyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionGenerationRef = useRef(sessionGeneration);
  sessionGenerationRef.current = sessionGeneration;

  useEffect(() => {
    setError(null);
    setCopyBusy(false);
  }, [sessionGeneration]);

  useEffect(() => {
    if (!project?.is_template || !authUser) {
      setCopyDialog((current) =>
        current && current.projectId === project?.id ? null : current
      );
      return;
    }
    setCopyDialog((current) => {
      if (current && current.projectId === project.id) return current;
      return {
        projectId: project.id,
        sourceName: project.name,
        suggestedName: `${project.name} ${t("projects.copySuffix")}`
      };
    });
  }, [
    authUser,
    project?.id,
    project?.is_template,
    project?.name,
    t
  ]);

  const createProjectFromTemplate = useCallback(async () => {
    if (!copyDialog || !copyDialog.suggestedName.trim()) return;
    const operationGeneration = sessionGeneration;
    try {
      setCopyBusy(true);
      const created = await copyProject(copyDialog.projectId, {
        name: copyDialog.suggestedName.trim()
      });
      await refreshProjects().catch(() => undefined);
      if (sessionGenerationRef.current !== operationGeneration) return;
      setCopyDialog(null);
      navigate(`/project/${created.id}`, { replace: true });
    } catch (error) {
      if (sessionGenerationRef.current !== operationGeneration) return;
      setError(
        errorMessage(error, t("projects.copyFailed"))
      );
    } finally {
      if (sessionGenerationRef.current === operationGeneration) {
        setCopyBusy(false);
      }
    }
  }, [copyDialog, navigate, refreshProjects, sessionGeneration, t]);

  const renameCurrentProject = useCallback(async (nextName: string) => {
    if (!projectId || !nextName.trim()) return false;
    const operationGeneration = sessionGeneration;
    try {
      await renameProject(projectId, nextName.trim());
      await refreshProjects();
      if (sessionGenerationRef.current !== operationGeneration) return false;
      setError(null);
      return true;
    } catch (error) {
      if (sessionGenerationRef.current !== operationGeneration) return false;
      setError(
        errorMessage(error, t("projects.renameFailed"))
      );
      return false;
    }
  }, [projectId, refreshProjects, sessionGeneration, t]);

  return {
    error,
    copyDialog,
    setCopyDialog,
    copyBusy,
    createProjectFromTemplate,
    renameCurrentProject
  };
}
