import { UiButton } from "@/components/ui";
import type { Project } from "@/lib/api";
import type { Translator } from "@/lib/i18n";

export function WorkspaceAccessBanner({
  project,
  isAnonymousShare,
  isShareLinkContext,
  isAuthenticated,
  saveStatus,
  saveError,
  onSaveToProjects,
  onRequestSignIn,
  onCopyTemplate,
  t
}: {
  project: Project | undefined;
  isAnonymousShare: boolean;
  isShareLinkContext: boolean;
  isAuthenticated: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  onSaveToProjects?: (() => Promise<void>) | undefined;
  onRequestSignIn: () => void;
  onCopyTemplate: () => void;
  t: Translator;
}) {
  if (isAnonymousShare) {
    return (
      <div className="workspace-access-banner with-action workspace-message-with-action" role="status">
        <span className="message-text">
          {project?.is_template
            ? t("share.templateSavePrompt", { name: project.name })
            : t("share.savePrompt")}
        </span>
        <UiButton size="sm" onClick={onRequestSignIn}>
          {t("share.logIn")}
        </UiButton>
      </div>
    );
  }

  if (isShareLinkContext && isAuthenticated) {
    return (
      <div className="workspace-access-banner with-action workspace-message-with-action" role="status">
        <span className="message-text">
          {saveStatus === "saved" ? t("share.savedToProjects") : t("share.saveToProjectsPrompt")}
        </span>
        {saveStatus !== "saved" && onSaveToProjects && (
          <UiButton size="sm" onClick={() => onSaveToProjects()} disabled={saveStatus === "saving"}>
            {saveStatus === "saving" ? t("share.savingToProjects") : t("share.saveToProjects")}
          </UiButton>
        )}
        {saveError && <span className="workspace-error">{saveError}</span>}
      </div>
    );
  }

  if (project?.is_template) {
    return (
      <div className="workspace-access-banner with-action template-banner workspace-message-with-action" role="status">
        <span className="message-text">{`${t("settings.templateEnabled")} · ${t("projects.copyDialogHint")} ${project.name}`}</span>
        <UiButton size="sm" onClick={onCopyTemplate}>
          {t("projects.copyAction")}
        </UiButton>
      </div>
    );
  }

  return null;
}
