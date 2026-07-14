import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
  getAuthMe,
  joinProjectShareLink,
  setShareAccessContext,
  temporaryShareLogin,
  type AuthUser
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

const GUEST_DISPLAY_NAME_KEY = "guest.display_name";

function sessionStorageKey(projectId: string) {
  return `guest.share.${projectId}.session`;
}

function readStoredValue(key: string) {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key);
}

type UseWorkspaceGuestSessionInput = {
  projectId: string;
  authUser: AuthUser | null;
  shareToken?: string | null;
  navigate: NavigateFunction;
  refreshProjects: () => Promise<void>;
  onSignInFromWorkspace?: () => Promise<void>;
  t: Translator;
};

type GuestSessionState = {
  projectId: string;
  token: string | null;
  sessionId: string | null;
  displayName: string;
};

type GuestAuthDialogState = {
  open: boolean;
  name: string;
  validationError: string | null;
};

export function useWorkspaceGuestSession({
  projectId,
  authUser,
  shareToken,
  navigate,
  refreshProjects,
  onSignInFromWorkspace,
  t
}: UseWorkspaceGuestSessionInput) {
  const initialSessionKey = sessionStorageKey(projectId);
  const [guestSession, setGuestSession] = useState<GuestSessionState>(() => ({
    projectId,
    token: projectId ? readStoredValue(initialSessionKey) : null,
    sessionId: projectId ? readStoredValue(`${initialSessionKey}.id`) : null,
    displayName: readStoredValue(GUEST_DISPLAY_NAME_KEY) ?? ""
  }));
  const [authDialog, setAuthDialog] = useState<GuestAuthDialogState>({
    open: false,
    name: "",
    validationError: null
  });
  const currentGuestSession =
    guestSession.projectId === projectId ? guestSession : null;
  const guestSessionToken = currentGuestSession?.token ?? null;
  const guestSessionId = currentGuestSession?.sessionId ?? null;
  const isAnonymousShare = !!shareToken && !authUser;
  const shareGuestSession = isAnonymousShare ? guestSessionToken : null;
  const effectiveUserId =
    authUser?.user_id || guestSessionId || `guest-${projectId || "workspace"}`;
  const effectiveUserName = authUser
    ? authUser.display_name || t("common.user")
    : guestSession.displayName
      ? t("workspace.unverifiedUser", { name: guestSession.displayName })
      : t("common.guest");

  const guestLogin = useMutation({
    mutationFn: ({ token, name }: { token: string; name: string }) =>
      temporaryShareLogin(token, name),
    onSuccess: (session) => {
      const key = sessionStorageKey(projectId);
      window.localStorage.setItem(GUEST_DISPLAY_NAME_KEY, session.display_name);
      window.localStorage.setItem(key, session.session_token);
      window.localStorage.setItem(`${key}.id`, session.session_id);
      setGuestSession({
        projectId,
        token: session.session_token,
        sessionId: session.session_id,
        displayName: session.display_name
      });
      setAuthDialog((current) => ({ ...current, open: false }));
    }
  });

  useEffect(() => {
    if (!projectId) {
      setGuestSession((current) => ({
        ...current,
        projectId: "",
        token: null,
        sessionId: null
      }));
      return;
    }
    const key = sessionStorageKey(projectId);
    setGuestSession((current) => ({
      ...current,
      projectId,
      token: readStoredValue(key),
      sessionId: readStoredValue(`${key}.id`)
    }));
  }, [projectId]);

  useEffect(() => {
    setShareAccessContext(
      shareToken
        ? { shareToken, guestSession: shareGuestSession }
        : { shareToken: null, guestSession: null }
    );
  }, [shareGuestSession, shareToken]);

  function openAuthModal() {
    guestLogin.reset();
    setAuthDialog((current) => ({
      ...current,
      open: true,
      validationError: null
    }));
  }

  async function beginTemporaryGuestEditing() {
    if (!shareToken || !projectId || guestLogin.isPending) return false;
    const chosenName = authDialog.name.trim();
    if (!chosenName) {
      setAuthDialog((current) => ({
        ...current,
        validationError: t("auth.username")
      }));
      return false;
    }
    try {
      setAuthDialog((current) => ({
        ...current,
        validationError: null
      }));
      await guestLogin.mutateAsync({ token: shareToken, name: chosenName });
      return true;
    } catch {
      return false;
    }
  }

  async function handleAuthModalSignedIn() {
    if (shareToken) {
      await joinProjectShareLink(shareToken).catch(() => undefined);
    }
    if (onSignInFromWorkspace) {
      await onSignInFromWorkspace();
    } else {
      await getAuthMe();
    }
    await refreshProjects();
    setAuthDialog((current) => ({ ...current, open: false }));
    navigate(`/project/${projectId}`, { replace: true });
  }

  const guestAuthError =
    authDialog.validationError ??
    (guestLogin.error instanceof Error
      ? guestLogin.error.message
      : guestLogin.isError
        ? t("errors.guestSession")
        : null);

  return {
    guestSessionToken,
    shareGuestSession,
    isAnonymousShare,
    effectiveUserId,
    effectiveUserName,
    authModalOpen: authDialog.open,
    openAuthModal,
    closeAuthModal: () =>
      setAuthDialog((current) => ({ ...current, open: false })),
    guestNameInput: authDialog.name,
    setGuestNameInput: (name: string) => {
      guestLogin.reset();
      setAuthDialog((current) => ({
        ...current,
        name,
        validationError: null
      }));
    },
    guestAuthError,
    guestAuthPending: guestLogin.isPending,
    beginTemporaryGuestEditing,
    handleAuthModalSignedIn
  };
}
