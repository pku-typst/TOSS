import { lazy, type ReactNode } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError
} from "react-router-dom";
import { App, useAppContext, type AppRouteHandle } from "@/App";
import { safeReturnPath } from "@/lib/experience";
import { readStoredLocale, translate } from "@/lib/i18n";
import { HomePage } from "@/pages/HomePage";
import { SignInPage } from "@/pages/SignInPage";
import { StatusPage } from "@/pages/StatusPage";

const AdminPage = lazy(() =>
  import("@/pages/AdminPage").then((module) => ({ default: module.AdminPage }))
);
const GalleryPage = lazy(() =>
  import("@/pages/GalleryPage").then((module) => ({ default: module.GalleryPage }))
);
const HelpPage = lazy(() =>
  import("@/pages/HelpPage").then((module) => ({ default: module.HelpPage }))
);
const ProfilePage = lazy(() =>
  import("@/pages/ProfilePage").then((module) => ({ default: module.ProfilePage }))
);
const ProjectsPage = lazy(() =>
  import("@/pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage }))
);
const ShareWorkspacePage = lazy(() =>
  import("@/pages/ShareWorkspacePage").then((module) => ({
    default: module.ShareWorkspacePage
  }))
);
const WorkspacePage = lazy(() =>
  import("@/pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage }))
);

type SignInLocationState = { from?: string };

function currentPath(location: ReturnType<typeof useLocation>) {
  return safeReturnPath(`${location.pathname}${location.search}${location.hash}`);
}

function signInReturnPath(location: ReturnType<typeof useLocation>) {
  const state = location.state as SignInLocationState | null;
  const fromState = typeof state?.from === "string" ? state.from : null;
  const fromQuery = new URLSearchParams(location.search).get("returnTo");
  return safeReturnPath(fromState ?? fromQuery);
}

function RouteLoading({ children }: { children: ReactNode }) {
  return (
    <div className="route-loading" role="status">
      <span className="route-loading-indicator" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function RequireAuthenticatedRoute() {
  const context = useAppContext();
  const location = useLocation();
  if (!context.authUser) {
    const returnTo = currentPath(location);
    return (
      <Navigate
        to={`/signin?returnTo=${encodeURIComponent(returnTo)}`}
        state={{ from: returnTo } satisfies SignInLocationState}
        replace
      />
    );
  }
  if (!context.signedInContextReady) {
    return <RouteLoading>{context.t("common.loading")}</RouteLoading>;
  }
  return <Outlet />;
}

function HomeRoute() {
  const { authUser, experience, locale, t } = useAppContext();
  const navigate = useNavigate();
  if (authUser) return <Navigate to="/projects" replace />;
  return (
    <HomePage
      experience={experience}
      locale={locale}
      t={t}
      onSignIn={() => navigate("/signin")}
      onOpenHelp={() => navigate("/help")}
    />
  );
}

function SignInRoute() {
  const { authUser, authConfig, locale, t, changeLocale, completeSignIn } = useAppContext();
  const location = useLocation();
  const returnTo = signInReturnPath(location);
  const linkProviderId = new URLSearchParams(location.search).get("link_provider");
  const accountLinkProvider =
    authConfig?.external_git_providers.find(
      (provider) => provider.id === linkProviderId
    ) ?? null;
  if (authUser) return <Navigate to={returnTo} replace />;
  return (
    <SignInPage
      config={authConfig}
      locale={locale}
      t={t}
      onLocaleChange={changeLocale}
      showLocaleSwitcher={false}
      returnTo={returnTo}
      accountLinkProvider={accountLinkProvider}
      onSignedIn={() => completeSignIn(returnTo)}
    />
  );
}

function HelpRoute() {
  const { authUser, locale, t } = useAppContext();
  return (
    <HelpPage
      cacheIdentity={authUser?.user_id ?? "anonymous"}
      locale={locale}
      t={t}
    />
  );
}

function ProjectsRoute() {
  const context = useAppContext();
  return (
    <ProjectsPage
      projects={context.projects}
      organizations={context.organizations}
      enabledProjectTypes={context.enabledProjectTypes}
      externalGitProviders={context.authConfig.external_git_providers}
      processingUserId={context.authUser?.user_id}
      refreshProjects={context.refreshProjects}
      locale={context.locale}
      t={context.t}
    />
  );
}

function GalleryRoute() {
  const context = useAppContext();
  return (
    <GalleryPage
      cacheIdentity={context.authUser?.user_id ?? ""}
      projects={context.projects}
      locale={context.locale}
      t={context.t}
      refreshProjects={context.refreshProjects}
    />
  );
}

function ProjectRoute() {
  const context = useAppContext();
  const location = useLocation();
  return (
    <WorkspacePage
      projects={context.projects}
      organizations={context.organizations}
      authUser={context.authUser}
      authConfig={context.authConfig}
      locale={context.locale}
      onLocaleChange={context.changeLocale}
      refreshProjects={context.refreshProjects}
      t={context.t}
      onSignInFromWorkspace={() => context.completeSignIn(currentPath(location))}
      onLogoutFromWorkspace={context.handleLogout}
    />
  );
}

function ShareRoute() {
  const context = useAppContext();
  const location = useLocation();
  return (
    <ShareWorkspacePage
      authUser={context.authUser}
      authConfig={context.authConfig}
      projects={context.projects}
      organizations={context.organizations}
      refreshProjects={context.refreshProjects}
      locale={context.locale}
      t={context.t}
      onLocaleChange={context.changeLocale}
      onSignedIn={() => context.completeSignIn(currentPath(location))}
      onLogoutFromWorkspace={context.handleLogout}
    />
  );
}

function ProfileRoute() {
  const { authConfig, locale, t } = useAppContext();
  return (
    <ProfilePage
      externalGitProviders={authConfig.external_git_providers}
      locale={locale}
      t={t}
    />
  );
}

function AdminRoute() {
  const { hasAdminAccess, t } = useAppContext();
  const navigate = useNavigate();
  if (!hasAdminAccess) {
    return (
      <StatusPage
        kind="forbidden"
        title={t("status.forbiddenTitle")}
        description={t("status.forbiddenDescription")}
        actionLabel={t("status.backProjects")}
        onAction={() => navigate("/projects", { replace: true })}
      />
    );
  }
  return <AdminPage t={t} />;
}

function NotFoundRoute() {
  const { authUser, t } = useAppContext();
  const navigate = useNavigate();
  return (
    <StatusPage
      kind="not-found"
      title={t("status.notFoundTitle")}
      description={t("status.notFoundDescription")}
      actionLabel={authUser ? t("status.backProjects") : t("status.backHome")}
      onAction={() => navigate(authUser ? "/projects" : "/", { replace: true })}
      secondaryLabel={t("nav.help")}
      onSecondaryAction={() => navigate("/help")}
    />
  );
}

function RootRouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const locale = readStoredLocale();
  const t = (key: string) => translate(locale, key);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <StatusPage
      kind={notFound ? "not-found" : "startup"}
      title={t(notFound ? "status.notFoundTitle" : "status.startupTitle")}
      description={t(notFound ? "status.notFoundDescription" : "status.startupDescription")}
      actionLabel={t("status.backHome")}
      onAction={() => navigate("/", { replace: true })}
    />
  );
}

const handle = (value: AppRouteHandle) => value;

export const router = createBrowserRouter([
  {
    id: "app",
    path: "/",
    Component: App,
    errorElement: <RootRouteError />,
    children: [
      {
        id: "home",
        index: true,
        Component: HomeRoute,
        handle: handle({ page: "home" })
      },
      {
        id: "signin",
        path: "signin",
        Component: SignInRoute,
        handle: handle({ page: "signin", titleKey: "auth.signIn" })
      },
      {
        id: "help",
        path: "help",
        Component: HelpRoute,
        handle: handle({ page: "help", nav: "help", titleKey: "help.title" })
      },
      {
        id: "share",
        path: "share/:token",
        Component: ShareRoute,
        handle: handle({ page: "share", titleKey: "share.title", workspace: true })
      },
      {
        id: "authenticated",
        Component: RequireAuthenticatedRoute,
        children: [
          {
            id: "projects",
            path: "projects",
            Component: ProjectsRoute,
            handle: handle({ page: "projects", nav: "projects", titleKey: "projects.title" })
          },
          {
            id: "gallery",
            path: "gallery",
            Component: GalleryRoute,
            handle: handle({ page: "gallery", nav: "gallery", titleKey: "gallery.title" })
          },
          {
            id: "project",
            path: "project/:projectId",
            Component: ProjectRoute,
            handle: handle({ page: "project", workspace: true })
          },
          {
            id: "profile",
            path: "profile",
            Component: ProfileRoute,
            handle: handle({ page: "profile", nav: "profile", titleKey: "profile.title" })
          },
          {
            id: "admin",
            path: "admin",
            Component: AdminRoute,
            handle: handle({ page: "admin", nav: "admin", titleKey: "admin.title" })
          }
        ]
      },
      {
        id: "not-found",
        path: "*",
        Component: NotFoundRoute,
        handle: handle({ page: "not-found", titleKey: "status.notFoundTitle" })
      }
    ]
  }
]);
