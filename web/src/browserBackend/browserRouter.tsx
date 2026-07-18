import { lazy } from "react";
import {
  Navigate,
  createHashRouter,
  useNavigate,
} from "react-router-dom";
import {
  BrowserApp,
  browserHelpContent,
  useBrowserAppContext,
  type BrowserRouteHandle,
} from "@/browserBackend/BrowserApp";
import {
  browserAuthUser,
} from "@/browserBackend/browserApplicationConfiguration";
import { StatusPage } from "@/pages/StatusPage";
import { browserWorkspaceFeatureAvailability } from "@/pages/workspace/featureAvailability";

const GalleryPage = lazy(() =>
  import("@/pages/GalleryPage").then((module) => ({ default: module.GalleryPage })),
);
const HelpPage = lazy(() =>
  import("@/pages/HelpPage").then((module) => ({ default: module.HelpPage })),
);
const ProjectsPage = lazy(() =>
  import("@/pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })),
);
const WorkspacePage = lazy(() =>
  import("@/pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage })),
);

function ProjectsRoute() {
  const context = useBrowserAppContext();
  return (
    <ProjectsPage
      projects={context.projects}
      organizations={[]}
      enabledProjectTypes={context.authConfig.enabled_project_types}
      externalGitProviders={[]}
      refreshProjects={context.refreshProjects}
      locale={context.locale}
      t={context.t}
    />
  );
}

function GalleryRoute() {
  const context = useBrowserAppContext();
  return (
    <GalleryPage
      cacheIdentity={browserAuthUser.user_id}
      projects={context.projects}
      locale={context.locale}
      t={context.t}
      refreshProjects={context.refreshProjects}
    />
  );
}

function WorkspaceRoute() {
  const context = useBrowserAppContext();
  return (
    <WorkspacePage
      projects={context.projects}
      organizations={[]}
      authUser={browserAuthUser}
      authConfig={context.authConfig}
      locale={context.locale}
      onLocaleChange={context.changeLocale}
      refreshProjects={context.refreshProjects}
      t={context.t}
      featureAvailability={browserWorkspaceFeatureAvailability}
    />
  );
}

function HelpRoute() {
  const context = useBrowserAppContext();
  return (
    <HelpPage
      cacheIdentity="browser"
      locale={context.locale}
      t={context.t}
      loadContent={async () => browserHelpContent}
    />
  );
}

function NotFoundRoute() {
  const { t } = useBrowserAppContext();
  const navigate = useNavigate();
  return (
    <StatusPage
      kind="not-found"
      title={t("status.notFoundTitle")}
      description={t("status.notFoundDescription")}
      actionLabel={t("status.backProjects")}
      onAction={() => navigate("/projects", { replace: true })}
    />
  );
}

const handle = (value: BrowserRouteHandle) => value;

export const browserRouter = createHashRouter([
  {
    path: "/",
    Component: BrowserApp,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      {
        path: "projects",
        Component: ProjectsRoute,
        handle: handle({ page: "projects", titleKey: "projects.title" }),
      },
      {
        path: "gallery",
        Component: GalleryRoute,
        handle: handle({ page: "gallery", titleKey: "gallery.title" }),
      },
      {
        path: "project/:projectId",
        Component: WorkspaceRoute,
        handle: handle({ page: "project", workspace: true }),
      },
      {
        path: "help",
        Component: HelpRoute,
        handle: handle({ page: "help", titleKey: "help.title" }),
      },
      {
        path: "*",
        Component: NotFoundRoute,
        handle: handle({ page: "not-found", titleKey: "status.notFoundTitle" }),
      },
    ],
  },
]);
