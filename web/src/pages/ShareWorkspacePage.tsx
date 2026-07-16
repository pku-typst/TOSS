import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  joinProjectShareLink,
  resolveProjectShareLink,
  type AnonymousMode,
  type AuthConfig,
  type AuthUser,
  type OrganizationMembership,
  type Project,
  type ProjectPermission
} from "@/lib/api";
import { SignInPage } from "@/pages/SignInPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { UiButton, UiCard } from "@/components/ui";
import type { Translator, UiLocale } from "@/lib/i18n";

type ShareWorkspacePageProps = {
  authUser: AuthUser | null;
  authConfig: AuthConfig | null;
  projects: Project[];
  organizations: OrganizationMembership[];
  refreshProjects: () => Promise<void>;
  locale: UiLocale;
  t: Translator;
  onLocaleChange: (locale: UiLocale) => void;
  onSignedIn: () => Promise<void>;
  onLogoutFromWorkspace: () => Promise<void>;
};

type ResolvedShare = {
  projectId: string;
  projectName: string;
  permission: ProjectPermission;
  isTemplate: boolean;
  anonymousMode: AnonymousMode;
};

function mapResolvedShare(
  value: Awaited<ReturnType<typeof resolveProjectShareLink>>
): ResolvedShare {
  return {
    projectId: value.project_id,
    projectName: value.project_name,
    permission: value.permission,
    isTemplate: value.is_template,
    anonymousMode: value.anonymous_mode
  };
}

export function ShareWorkspacePage({
  authUser,
  authConfig,
  projects,
  organizations,
  refreshProjects,
  locale,
  t,
  onLocaleChange,
  onSignedIn,
  onLogoutFromWorkspace
}: ShareWorkspacePageProps) {
  const { token = "" } = useParams();
  const autoJoinAttemptedRef = useRef<string | null>(null);
  const shareQuery = useQuery({
    queryKey: ["project-share", token],
    queryFn: () => resolveProjectShareLink(token),
    select: mapResolvedShare,
    enabled: !!token,
    retry: false
  });
  const resolved = shareQuery.data ?? null;

  const alreadySavedToProjects = useMemo(
    () => !!resolved && projects.some((project) => project.id === resolved.projectId),
    [projects, resolved]
  );

  const joinMutation = useMutation({
    mutationKey: ["join-project-share", token],
    mutationFn: () => joinProjectShareLink(token),
    onSuccess: () => refreshProjects()
  });
  const {
    error: joinError,
    isError: joinFailed,
    isPending: joinPending,
    isSuccess: joinSucceeded,
    mutateAsync: joinShare,
    reset: resetJoinMutation
  } = joinMutation;
  useEffect(() => {
    autoJoinAttemptedRef.current = null;
    resetJoinMutation();
  }, [resetJoinMutation, token]);

  const saveSharedProjectToList = useCallback(async () => {
    if (!resolved || joinPending) return;
    autoJoinAttemptedRef.current = token;
    await joinShare();
  }, [joinPending, joinShare, resolved, token]);

  useEffect(() => {
    if (!authUser || !resolved) return;
    if (alreadySavedToProjects) return;
    if (autoJoinAttemptedRef.current === token) return;
    autoJoinAttemptedRef.current = token;
    void joinShare().catch(() => undefined);
  }, [alreadySavedToProjects, authUser, joinShare, resolved, token]);

  const saveStatus: "idle" | "saving" | "saved" | "error" =
    alreadySavedToProjects || joinSucceeded
      ? "saved"
      : joinPending
        ? "saving"
        : joinFailed
          ? "error"
          : "idle";
  const saveError = joinError
    ? joinError instanceof Error
      ? joinError.message
      : t("share.joinFailed")
    : null;
  const error = shareQuery.error
    ? shareQuery.error instanceof Error
      ? shareQuery.error.message
      : t("share.joinFailed")
    : null;

  const pseudoProject = useMemo<Project[]>(
    () =>
      resolved
        ? [
            {
              id: resolved.projectId,
              name: resolved.projectName,
              project_type: "typst",
              latex_engine: null,
              owner_user_id: null,
              owner_display_name: "",
              my_role: resolved.permission === "write" ? "ReadWrite" : "ReadOnly",
              can_read: true,
              is_template: resolved.isTemplate,
              has_thumbnail: false,
              created_at: new Date(0).toISOString(),
              last_edited_at: new Date().toISOString(),
              archived: false,
              archived_at: null
            }
          ]
        : [],
    [resolved]
  );

  if (shareQuery.isPending) {
    return (
      <section className="app-page" nve-layout="column gap:lg pad:md @md|pad:xl">
        <UiCard>
          <span nve-text="body muted">{t("common.loading")}</span>
        </UiCard>
      </section>
    );
  }
  if (error || !resolved) {
    return (
      <section className="app-page" nve-layout="column gap:lg pad:md @md|pad:xl">
        <UiCard>
          <h1 nve-text="heading lg">{t("share.joinFailed")}</h1>
          {error && (
            <nve-alert status="danger" role="alert">
              <span>{error}</span>
            </nve-alert>
          )}
        </UiCard>
      </section>
    );
  }

  if (!authUser && resolved.anonymousMode === "off") {
    return (
      <SignInPage
        config={authConfig}
        locale={locale}
        t={t}
        onLocaleChange={onLocaleChange}
        showLocaleSwitcher={false}
        onSignedIn={onSignedIn}
      />
    );
  }

  if (authUser && resolved && !alreadySavedToProjects && saveStatus !== "saved") {
    return (
      <section className="app-page" nve-layout="column gap:lg pad:md @md|pad:xl">
        <UiCard>
          <h1 nve-text="heading lg">
            {saveStatus === "saving" ? t("share.joining") : t("share.saveToProjectsPrompt")}
          </h1>
          {saveError && (
            <nve-alert status="danger" role="alert">
              <span>{saveError}</span>
            </nve-alert>
          )}
          {saveStatus !== "saving" && (
            <UiButton
              variant="primary"
              onClick={() => {
                saveSharedProjectToList().catch(() => undefined);
              }}
            >
              {t("share.saveToProjects")}
            </UiButton>
          )}
        </UiCard>
      </section>
    );
  }

  return (
    <WorkspacePage
      projects={pseudoProject}
      organizations={organizations}
      authUser={authUser}
      authConfig={authConfig}
      locale={locale}
      onLocaleChange={onLocaleChange}
      refreshProjects={refreshProjects}
      t={t}
      projectIdOverride={resolved.projectId}
      shareToken={token}
      sharePermission={resolved.permission}
      anonymousMode={resolved.anonymousMode}
      shareSaveStatus={saveStatus}
      shareSaveError={saveError}
      onSaveSharedProject={saveSharedProjectToList}
      onSignInFromWorkspace={onSignedIn}
      onLogoutFromWorkspace={onLogoutFromWorkspace}
    />
  );
}
