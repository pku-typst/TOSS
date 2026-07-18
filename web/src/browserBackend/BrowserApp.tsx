import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleHelp, Menu } from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from "react-router-dom";
import {
  browserAuthConfig,
  browserBuildConfiguration,
  browserExperience,
} from "@/browserBackend/browserApplicationConfiguration";
import { BrandMark } from "@/components/BrandMark";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { UiButton, UiIconButton } from "@/components/ui";
import type { AuthConfig, Experience, Project } from "@/lib/api/types";
import {
  readStoredLocale,
  translate,
  writeStoredLocale,
  type Translator,
  type TranslationValues,
  type UiLocale,
} from "@/lib/i18n";
import { useProjectCatalog } from "@/projects/projectCatalog";

export type BrowserRouteHandle = {
  page: "projects" | "gallery" | "help" | "project" | "not-found";
  titleKey?: string;
  workspace?: boolean;
};

type BrowserAppContextValue = {
  authConfig: AuthConfig;
  experience: Experience;
  locale: UiLocale;
  t: Translator;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  changeLocale: (locale: UiLocale) => void;
};

const BrowserAppContext = createContext<BrowserAppContextValue | null>(null);

export function useBrowserAppContext() {
  const context = useContext(BrowserAppContext);
  if (!context) throw new Error("browser_app_context_missing");
  return context;
}

function TopbarLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) => `topbar-link${isActive ? " active" : ""}`}
    >
      {children}
    </NavLink>
  );
}

function LoadingPage({ label }: { label: string }) {
  return (
    <div className="route-loading" role="status">
      <span className="route-loading-indicator" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function BrowserApp() {
  const projectCatalog = useProjectCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const contentRef = useRef<HTMLElement | null>(null);
  const [locale, setLocale] = useState<UiLocale>(readStoredLocale);
  const authConfig = useMemo(browserAuthConfig, []);
  const experience = useMemo(browserExperience, []);
  const t = useMemo<Translator>(
    () => (key: string, values?: TranslationValues) =>
      translate(locale, key, values),
    [locale],
  );
  const projectsQuery = useQuery({
    queryKey: ["browser-projects"],
    queryFn: () => projectCatalog.list({ includeArchived: true }),
    retry: false,
  });
  const refetchProjects = projectsQuery.refetch;
  const refreshProjects = useCallback(async () => {
    const result = await refetchProjects();
    if (result.isError) throw result.error;
  }, [refetchProjects]);
  const changeLocale = useCallback((nextLocale: UiLocale) => {
    writeStoredLocale(nextLocale);
    setLocale(nextLocale);
  }, []);
  const routeHandle = ([...matches]
    .reverse()
    .find((match) => match.handle)?.handle ?? {
    page: "projects",
  }) as BrowserRouteHandle;
  const onWorkspaceRoute = routeHandle.workspace === true;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const title = routeHandle.titleKey ? t(routeHandle.titleKey) : null;
    document.title = title
      ? `${title} · ${experience.product.name}`
      : experience.product.name;
  }, [experience.product.name, routeHandle.titleKey, t]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--toss-brand-accent", experience.product.accent_color);
    root.style.setProperty(
      "--toss-brand-contrast",
      experience.product.accent_text_color,
    );
  }, [experience.product.accent_color, experience.product.accent_text_color]);

  useEffect(() => {
    if (onWorkspaceRoute) return;
    const frame = requestAnimationFrame(() => {
      contentRef.current?.scrollTo({ top: 0, left: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, onWorkspaceRoute]);

  const context = useMemo<BrowserAppContextValue>(
    () => ({
      authConfig,
      experience,
      locale,
      t,
      projects: projectsQuery.data?.projects ?? [],
      refreshProjects,
      changeLocale,
    }),
    [
      authConfig,
      changeLocale,
      experience,
      locale,
      projectsQuery.data?.projects,
      refreshProjects,
      t,
    ],
  );
  const closeMobileNavigation = () =>
    document.getElementById("browser-navigation-menu")?.hidePopover();
  const navigateFromMenu = (to: string) => {
    closeMobileNavigation();
    navigate(to);
  };

  return (
    <BrowserAppContext.Provider value={context}>
      <a className="skip-link" href="#app-main-content">
        {t("nav.skipToContent")}
      </a>
      <nve-page className="app-shell">
        <nve-page-header
          slot="header"
          className={`topbar ${onWorkspaceRoute ? "workspace" : ""}`}
        >
          <Link
            slot="prefix"
            to="/projects"
            className="topbar-brand-link"
            aria-label={experience.product.name}
          >
            <BrandMark
              className="topbar-brand-mark"
              mark={experience.product.brand_mark}
              label={experience.product.name}
            />
            <strong className="topbar-brand">{experience.product.name}</strong>
          </Link>
          {onWorkspaceRoute ? (
            <>
              <UiButton
                slot="prefix"
                variant="ghost"
                className="tab topbar-back-btn"
                onClick={() => navigate("/projects")}
                aria-label={t("nav.backToProjects")}
              >
                <ArrowLeft className="topbar-back-icon" size={14} aria-hidden />
                <span className="topbar-back-label">{t("nav.backToProjects")}</span>
              </UiButton>
              <div className="topbar-workspace-slot">
                <div id="workspace-toolbar-portal" className="workspace-slot-center" />
              </div>
            </>
          ) : (
            <>
              <nav className="topbar-nav" aria-label={t("nav.menu")}>
                <TopbarLink to="/projects">{t("nav.projects")}</TopbarLink>
                <TopbarLink to="/gallery">{t("nav.gallery")}</TopbarLink>
              </nav>
              <nav className="topbar-nav-mobile" aria-label={t("nav.menu")}>
                <nve-button
                  role="button"
                  container="flat"
                  size="sm"
                  popovertarget="browser-navigation-menu"
                  aria-label={t("nav.openMenu")}
                >
                  <Menu size={16} aria-hidden />
                  {t("nav.menu")}
                </nve-button>
                <nve-dropdown
                  id="browser-navigation-menu"
                  className="app-navigation-dropdown"
                  position="bottom"
                  alignment="end"
                >
                  <nve-menu className="app-navigation-menu">
                    <nve-menu-item role="menuitem" onClick={() => navigateFromMenu("/projects")}>
                      {t("nav.projects")}
                    </nve-menu-item>
                    <nve-menu-item role="menuitem" onClick={() => navigateFromMenu("/gallery")}>
                      {t("nav.gallery")}
                    </nve-menu-item>
                    <nve-menu-item role="menuitem" onClick={() => navigateFromMenu("/help")}>
                      {t("nav.help")}
                    </nve-menu-item>
                  </nve-menu>
                </nve-dropdown>
              </nav>
            </>
          )}
          <div slot="suffix" className="meta workspace-meta">
            <UiIconButton
              tooltip={t("nav.help")}
              label={t("nav.help")}
              onClick={() => navigate("/help")}
            >
              <CircleHelp size={17} aria-hidden />
            </UiIconButton>
            <LocaleSwitcher locale={locale} onChange={changeLocale} t={t} />
          </div>
        </nve-page-header>
        <section
          id="app-main-content"
          ref={contentRef}
          tabIndex={-1}
          className={`app-content ${
            onWorkspaceRoute ? "workspace-content" : "page-content"
          }`}
        >
          {projectsQuery.isError && (
            <div className="error-banner" role="alert">
              {projectsQuery.error instanceof Error
                ? projectsQuery.error.message
                : t("projects.loadFailed")}
            </div>
          )}
          <Suspense fallback={<LoadingPage label={t("common.loading")} />}>
            {projectsQuery.isPending ? (
              <LoadingPage label={t("common.loading")} />
            ) : (
              <Outlet />
            )}
          </Suspense>
        </section>
      </nve-page>
    </BrowserAppContext.Provider>
  );
}

export const browserHelpContent = browserBuildConfiguration.help;
