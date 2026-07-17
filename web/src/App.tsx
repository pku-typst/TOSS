import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleHelp, Menu } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useMatches, useNavigate } from "react-router-dom";
import {
  applicationBootstrapQueryKey,
  clearSessionQueryCaches,
  loadApplicationBootstrap,
  loadSignedInContext,
  signedInContextQueryKey,
  type ApplicationBootstrap
} from "@/applicationSession";
import { BrandMark } from "@/components/BrandMark";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { UiButton, UiDialog, UiIconButton } from "@/components/ui";
import {
  AUTH_REQUIRED_EVENT,
  clearProjectAssetContentCaches,
  clearShareAccessContext,
  getAuthMe,
  getExperience,
  joinProjectShareLink,
  logout,
  type AuthConfig,
  type AuthUser,
  type Experience,
  type OrganizationMembership,
  type Project
} from "@/lib/api";
import { deploymentProjectTypes, type ProjectType } from "@/lib/deploymentCapabilities";
import { safeReturnPath } from "@/lib/experience";
import {
  protocolCompatibilityState,
  subscribeProtocolCompatibility
} from "@/lib/protocolCompatibility";
import {
  readStoredLocale,
  translate,
  writeStoredLocale,
  type Translator,
  type TranslationValues,
  type UiLocale
} from "@/lib/i18n";
import { clearProjectSnapshotCaches } from "@/lib/projectCache";
import { StatusPage } from "@/pages/StatusPage";
import { ProcessingTaskCenter } from "@/pages/processing/ProcessingTaskCenter";

export type AppRouteHandle = {
  page?: "home" | "signin" | "projects" | "gallery" | "help" | "profile" | "admin" | "project" | "share" | "not-found";
  nav?: "projects" | "gallery" | "help" | "profile" | "admin";
  titleKey?: string;
  workspace?: boolean;
};

export type AppContextValue = {
  authConfig: AuthConfig;
  experience: Experience;
  authUser: AuthUser | null;
  locale: UiLocale;
  t: Translator;
  projects: Project[];
  organizations: OrganizationMembership[];
  hasAdminAccess: boolean;
  signedInContextReady: boolean;
  enabledProjectTypes: ProjectType[];
  changeLocale: (locale: UiLocale) => void;
  refreshProjects: () => Promise<void>;
  completeSignIn: (returnTo?: string) => Promise<void>;
  handleLogout: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error("app_context_missing");
  return context;
}

function AppBootBar() {
  return (
    <div className="app-boot__bar" aria-hidden>
      <span className="app-boot__mark" />
      <span className="app-boot__line app-boot__line--title" />
    </div>
  );
}

export function ProductBootSkeleton({ label }: { label: string }) {
  return (
    <main className="app-boot app-boot--product" role="status" aria-label={label}>
      <AppBootBar />
      <div className="app-boot__product" aria-hidden>
        <section className="app-boot__product-copy">
          <div className="app-boot__line app-boot__line--eyebrow" />
          <div className="app-boot__line app-boot__line--headline" />
          <div className="app-boot__line app-boot__line--headline-short" />
          <div className="app-boot__line app-boot__line--body" />
          <div className="app-boot__line app-boot__line--body-short" />
          <div className="app-boot__product-actions">
            <span />
            <span />
          </div>
        </section>
        <aside className="app-boot__product-visual">
          <div className="app-boot__product-window">
            <div className="app-boot__product-window-bar" />
            <div className="app-boot__product-window-body">
              <span />
              <span />
              <span />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

export function WorkspaceBootSkeleton({ label }: { label: string }) {
  return (
    <main className="app-boot app-boot--workspace" role="status" aria-label={label}>
      <AppBootBar />
      <div className="app-boot__layout" aria-hidden>
        <aside className="app-boot__panel app-boot__rail">
          <div className="app-boot__line app-boot__line--medium" />
          <div className="app-boot__line" />
          <div className="app-boot__line app-boot__line--short" />
        </aside>
        <section className="app-boot__panel">
          <div className="app-boot__line app-boot__line--title" />
          <div className="app-boot__line" />
          <div className="app-boot__line app-boot__line--medium" />
          <div className="app-boot__line" />
          <div className="app-boot__line app-boot__line--short" />
        </section>
        <aside className="app-boot__panel app-boot__preview">
          <div className="app-boot__page">
            <div className="app-boot__line app-boot__line--title" />
            <div className="app-boot__line" />
            <div className="app-boot__line app-boot__line--medium" />
          </div>
        </aside>
      </div>
    </main>
  );
}

function WorkspaceContentSkeleton({ label }: { label: string }) {
  return (
    <div className="workspace-boot-content" role="status" aria-label={label}>
      <div className="app-boot__layout" aria-hidden>
        <aside className="app-boot__panel app-boot__rail">
          <div className="app-boot__line app-boot__line--medium" />
          <div className="app-boot__line" />
          <div className="app-boot__line app-boot__line--short" />
        </aside>
        <section className="app-boot__panel">
          <div className="app-boot__line app-boot__line--title" />
          <div className="app-boot__line" />
          <div className="app-boot__line app-boot__line--medium" />
          <div className="app-boot__line" />
        </section>
        <aside className="app-boot__panel app-boot__preview">
          <div className="app-boot__page">
            <div className="app-boot__line app-boot__line--title" />
            <div className="app-boot__line" />
          </div>
        </aside>
      </div>
    </div>
  );
}

function PageContentSkeleton({ label }: { label: string }) {
  return (
    <div className="page-boot-content" role="status" aria-label={label}>
      <div className="app-boot__line app-boot__line--eyebrow" aria-hidden />
      <div className="app-boot__line app-boot__line--headline-short" aria-hidden />
      <div className="app-boot__line app-boot__line--body" aria-hidden />
      <div className="app-boot__line app-boot__line--body-short" aria-hidden />
    </div>
  );
}

function TopbarAccountControls({
  displayName,
  onLogout,
  t
}: {
  displayName: string;
  onLogout: () => Promise<void>;
  t: Translator;
}) {
  return (
    <>
      <span className="topbar-account-name">{displayName}</span>
      <UiButton onClick={() => void onLogout()}>{t("nav.logout")}</UiButton>
    </>
  );
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

export function App() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const sessionResettingRef = useRef(false);
  const contentRef = useRef<HTMLElement | null>(null);
  const [locale, setLocale] = useState<UiLocale>(readStoredLocale);
  const [operationError, setOperationError] = useState<string | null>(null);
  const compatibilityState = useSyncExternalStore(
    subscribeProtocolCompatibility,
    protocolCompatibilityState,
    protocolCompatibilityState
  );
  const reloadRequired = compatibilityState === "reload_required";

  const routeMatch = [...matches]
    .reverse()
    .find((match) => match.handle && Object.keys(match.handle as object).length > 0);
  const routeHandle = (routeMatch?.handle ?? {}) as AppRouteHandle;
  const onWorkspaceRoute = routeHandle.workspace === true;
  const onShareRoute = routeHandle.page === "share";
  const activeNavigation = routeHandle.nav;
  const onAuthenticatedRoute = matches.some((match) => match.id === "authenticated");
  const shareMatch = matches.find((match) => match.id === "share");
  const projectMatch = matches.find((match) => match.id === "project");
  const shareToken = shareMatch?.params.token ?? null;
  const projectId = projectMatch?.params.projectId ?? null;

  const t = useMemo<Translator>(
    () => (key: string, values?: TranslationValues) => translate(locale, key, values),
    [locale]
  );
  const changeLocale = useCallback((nextLocale: UiLocale) => {
    writeStoredLocale(nextLocale);
    setLocale(nextLocale);
  }, []);

  const bootstrapQuery = useQuery({
    queryKey: applicationBootstrapQueryKey,
    queryFn: loadApplicationBootstrap,
    retry: false
  });
  const authConfig = bootstrapQuery.data?.authConfig ?? null;
  const experience = bootstrapQuery.data?.experience ?? null;
  const authUser = bootstrapQuery.data?.authUser ?? null;
  const signedInContextQuery = useQuery({
    queryKey: signedInContextQueryKey(authUser?.user_id ?? "anonymous"),
    queryFn: loadSignedInContext,
    enabled: !!authUser,
    retry: false
  });
  const projects = authUser
    ? (signedInContextQuery.data?.projects ?? [])
    : [];
  const organizations = authUser
    ? (signedInContextQuery.data?.organizations ?? [])
    : [];
  const hasAdminAccess =
    !!authUser && (signedInContextQuery.data?.hasAdminAccess ?? false);
  const signedInContextReady =
    !authUser || !signedInContextQuery.isPending;
  const signedInContextError = signedInContextQuery.error
    ? signedInContextQuery.error instanceof Error
      ? signedInContextQuery.error.message
      : t("projects.loadFailed")
    : null;
  const error = operationError ?? signedInContextError;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!shareToken) return;
    window.sessionStorage.setItem("share.token.pending", shareToken);
  }, [shareToken]);

  useEffect(() => {
    if (!onShareRoute) clearShareAccessContext();
  }, [onShareRoute]);

  useEffect(() => {
    if (authUser) sessionResettingRef.current = false;
  }, [authUser]);

  useEffect(() => {
    const handleAuthenticationRequired = () => {
      if (!authUser || sessionResettingRef.current) return;
      sessionResettingRef.current = true;
      const returnTo = safeReturnPath(
        `${location.pathname}${location.search}${location.hash}`
      );
      clearProjectSnapshotCaches();
      queryClient.setQueryData<ApplicationBootstrap>(
        applicationBootstrapQueryKey,
        (current) => current ? { ...current, authUser: null } : current
      );
      clearSessionQueryCaches(queryClient);
      void clearProjectAssetContentCaches().catch(() => undefined);
      void getExperience()
        .then((publicExperience) => {
          queryClient.setQueryData<ApplicationBootstrap>(
            applicationBootstrapQueryKey,
            (current) =>
              current && !current.authUser
                ? { ...current, experience: publicExperience }
                : current
          );
        })
        .catch(() => undefined);
      navigate(`/signin?returnTo=${encodeURIComponent(returnTo)}`, {
        state: { from: returnTo },
        replace: true
      });
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthenticationRequired);
  }, [authUser, location.hash, location.pathname, location.search, navigate, queryClient]);

  useEffect(() => {
    if (onWorkspaceRoute) return;
    const frame = window.requestAnimationFrame(() => {
      if (!contentRef.current) return;
      contentRef.current.scrollTop = 0;
      contentRef.current.scrollLeft = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname, onWorkspaceRoute]);

  const productName = experience?.product.name?.trim() || t("brand.name");
  const siteName = authConfig?.site_name?.trim() || productName;
  const brandMark = experience?.product.brand_mark?.trim() || authConfig?.brand_mark?.trim() || "T";
  const activeProject = projectId
    ? projects.find((project) => project.id === projectId)
    : null;
  const pageTitle = useMemo(() => {
    if (onAuthenticatedRoute && !authUser) return t("auth.signIn");
    if (routeHandle.page === "home") return null;
    if (routeHandle.page === "project") return activeProject?.name ?? null;
    return routeHandle.titleKey ? t(routeHandle.titleKey) : null;
  }, [activeProject?.name, authUser, onAuthenticatedRoute, routeHandle.page, routeHandle.titleKey, t]);

  useEffect(() => {
    if (!experience) return;
    const nextTitle = pageTitle ? `${pageTitle} · ${productName}` : productName;
    if (document.title !== nextTitle) document.title = nextTitle;
  }, [experience, pageTitle, productName]);

  useEffect(() => {
    const root = document.documentElement;
    if (experience?.product.accent_color) {
      root.style.setProperty("--toss-brand-accent", experience.product.accent_color);
      root.style.setProperty("--toss-brand-contrast", experience.product.accent_text_color);
    } else {
      root.style.removeProperty("--toss-brand-accent");
      root.style.removeProperty("--toss-brand-contrast");
    }
  }, [experience?.product.accent_color, experience?.product.accent_text_color]);

  useEffect(() => {
    if (!experience) return;
    const description = experience.product.description[locale] || experience.product.description.en;
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute("content", description);
  }, [experience, locale]);

  const handleLogout = useCallback(async () => {
    await logout();
    clearProjectSnapshotCaches();
    await clearProjectAssetContentCaches().catch(() => undefined);
    const publicExperience = await getExperience().catch(() => null);
    queryClient.setQueryData<ApplicationBootstrap>(
      applicationBootstrapQueryKey,
      (current) =>
        current
          ? {
              ...current,
              authUser: null,
              experience: publicExperience ?? current.experience
            }
          : current
    );
    clearSessionQueryCaches(queryClient);
    setOperationError(null);
    navigate("/", { replace: true });
  }, [navigate, queryClient]);

  const refetchSignedInContext = signedInContextQuery.refetch;
  const refreshProjects = useCallback(async () => {
    if (!authUser) return;
    const result = await refetchSignedInContext();
    if (result.isError) throw result.error;
    setOperationError(null);
  }, [authUser, refetchSignedInContext]);

  const completeSignIn = useCallback(
    async (returnTo = "/projects") => {
      const me = await getAuthMe();
      if (!me) throw new Error(t("api.status.unauthorized"));
      const authenticatedExperience = await getExperience();
      queryClient.setQueryData<ApplicationBootstrap>(
        applicationBootstrapQueryKey,
        (current) =>
          current
            ? {
                ...current,
                authUser: me,
                experience: authenticatedExperience
              }
            : current
      );
      sessionResettingRef.current = false;
      setOperationError(null);
      const pendingShare = shareToken || window.sessionStorage.getItem("share.token.pending");
      if (pendingShare) {
        window.sessionStorage.removeItem("share.token.pending");
        try {
          const joined = await joinProjectShareLink(pendingShare);
          await queryClient.fetchQuery({
            queryKey: signedInContextQueryKey(me.user_id),
            queryFn: loadSignedInContext,
            staleTime: 0
          });
          navigate(`/project/${joined.project_id}`, { replace: true });
        } catch (joinError) {
          setOperationError(
            joinError instanceof Error
              ? joinError.message
              : t("share.joinFailed")
          );
        }
        return;
      }
      navigate(returnTo, { replace: true });
    },
    [navigate, queryClient, shareToken, t]
  );

  if (reloadRequired && (!authConfig || !experience)) {
    return (
      <StatusPage
        kind="startup"
        title={t("compatibility.reloadTitle")}
        description={t("compatibility.reloadDescription")}
        actionLabel={t("compatibility.reloadAction")}
        onAction={() => window.location.reload()}
      />
    );
  }

  if (bootstrapQuery.isPending) {
    return onWorkspaceRoute ? (
      <WorkspaceBootSkeleton label={t("common.loading")} />
    ) : (
      <ProductBootSkeleton label={t("common.loading")} />
    );
  }

  if (!authConfig || !experience) {
    return (
      <StatusPage
        kind="startup"
        title={t("status.startupTitle")}
        description={t("status.startupDescription")}
        actionLabel={t("common.retry")}
        onAction={() => void bootstrapQuery.refetch()}
      />
    );
  }

  const enabledProjectTypes = deploymentProjectTypes(authConfig);
  const context: AppContextValue = {
    authConfig,
    experience,
    authUser,
    locale,
    t,
    projects,
    organizations,
    hasAdminAccess,
    signedInContextReady,
    enabledProjectTypes,
    changeLocale,
    refreshProjects,
    completeSignIn,
    handleLogout
  };

  const closeMobileNavigation = () => {
    document.getElementById("app-navigation-menu")?.hidePopover();
  };
  const navigateFromMobileNavigation = (to: string) => {
    closeMobileNavigation();
    navigate(to);
  };
  const homePath = authUser ? "/projects" : "/";

  return (
    <AppContext.Provider value={context}>
      <a className="skip-link" href="#app-main-content">
        {t("nav.skipToContent")}
      </a>
      <nve-page className="app-shell">
          <nve-page-header
            slot="header"
            className={`topbar ${onWorkspaceRoute ? "workspace" : ""}`}
          >
            <Link slot="prefix" to={homePath} className="topbar-brand-link" aria-label={siteName}>
              <BrandMark className="topbar-brand-mark" mark={brandMark} label={siteName} />
              <strong className="topbar-brand">{siteName}</strong>
            </Link>
            {onWorkspaceRoute && (
              <UiButton
                slot="prefix"
                variant="ghost"
                className="tab topbar-back-btn"
                onClick={() => navigate(homePath)}
                aria-label={authUser ? t("nav.backToProjects") : t("status.backHome")}
              >
                <ArrowLeft className="topbar-back-icon" size={14} aria-hidden />
                <span className="topbar-back-label">
                  {authUser ? t("nav.backToProjects") : t("status.backHome")}
                </span>
              </UiButton>
            )}
            {onWorkspaceRoute ? (
              <div className="topbar-workspace-slot">
                <div id="workspace-toolbar-portal" className="workspace-slot-center" />
              </div>
            ) : (
              <>
                <nav className="topbar-nav" aria-label={t("nav.menu")}>
                  {authUser ? (
                    <>
                      <TopbarLink to="/projects">{t("nav.projects")}</TopbarLink>
                      <TopbarLink to="/gallery">{t("nav.gallery")}</TopbarLink>
                      <TopbarLink to="/profile">{t("nav.profile")}</TopbarLink>
                      {hasAdminAccess && <TopbarLink to="/admin">{t("nav.admin")}</TopbarLink>}
                    </>
                  ) : routeHandle.page !== "home" ? (
                    <TopbarLink to="/">{t("nav.home")}</TopbarLink>
                  ) : null}
                </nav>
                <nav className="topbar-nav-mobile" aria-label={t("nav.menu")}>
                  <nve-button
                    role="button"
                    container="flat"
                    size="sm"
                    popovertarget="app-navigation-menu"
                    aria-label={t("nav.openMenu")}
                  >
                    <Menu size={16} aria-hidden />
                    {t("nav.menu")}
                  </nve-button>
                  <nve-dropdown
                    id="app-navigation-menu"
                    className="app-navigation-dropdown"
                    position="bottom"
                    alignment="end"
                  >
                    <nve-menu className="app-navigation-menu">
                      {authUser ? (
                        <>
                          <nve-menu-item
                            role="menuitem"
                            current={activeNavigation === "projects" ? "page" : undefined}
                            onClick={() => navigateFromMobileNavigation("/projects")}
                          >
                            {t("nav.projects")}
                          </nve-menu-item>
                          <nve-menu-item
                            role="menuitem"
                            current={activeNavigation === "gallery" ? "page" : undefined}
                            onClick={() => navigateFromMobileNavigation("/gallery")}
                          >
                            {t("nav.gallery")}
                          </nve-menu-item>
                          <nve-menu-item
                            role="menuitem"
                            current={activeNavigation === "profile" ? "page" : undefined}
                            onClick={() => navigateFromMobileNavigation("/profile")}
                          >
                            {t("nav.profile")}
                          </nve-menu-item>
                          {hasAdminAccess && (
                            <nve-menu-item
                              role="menuitem"
                              current={activeNavigation === "admin" ? "page" : undefined}
                              onClick={() => navigateFromMobileNavigation("/admin")}
                            >
                              {t("nav.admin")}
                            </nve-menu-item>
                          )}
                        </>
                      ) : (
                        <nve-menu-item role="menuitem" onClick={() => navigateFromMobileNavigation("/")}>
                          {t("nav.home")}
                        </nve-menu-item>
                      )}
                      <nve-menu-item
                        role="menuitem"
                        current={activeNavigation === "help" ? "page" : undefined}
                        onClick={() => navigateFromMobileNavigation("/help")}
                      >
                        {t("nav.help")}
                      </nve-menu-item>
                      {!authUser && (
                        <nve-menu-item
                          role="menuitem"
                          onClick={() => navigateFromMobileNavigation("/signin")}
                        >
                          {t("nav.signIn")}
                        </nve-menu-item>
                      )}
                      <nve-divider />
                      <nve-menu-item
                        role="menuitemradio"
                        current={locale === "en" ? "page" : undefined}
                        onClick={() => {
                          closeMobileNavigation();
                          changeLocale("en");
                        }}
                      >
                        {t("language.english")}
                      </nve-menu-item>
                      <nve-menu-item
                        role="menuitemradio"
                        current={locale === "zh-CN" ? "page" : undefined}
                        onClick={() => {
                          closeMobileNavigation();
                          changeLocale("zh-CN");
                        }}
                      >
                        {t("language.chineseSimplified")}
                      </nve-menu-item>
                      {authUser && (
                        <>
                          <nve-divider />
                          <nve-menu-item
                            role="menuitem"
                            onClick={() => {
                              closeMobileNavigation();
                              void handleLogout();
                            }}
                          >
                            {t("nav.logout")}
                          </nve-menu-item>
                        </>
                      )}
                    </nve-menu>
                  </nve-dropdown>
                </nav>
              </>
            )}
            <div slot="suffix" className="meta workspace-meta">
              {authUser && (
                <ProcessingTaskCenter
                  userId={authUser.user_id}
                  projects={projects}
                  locale={locale}
                  t={t}
                />
              )}
              <UiIconButton
                tooltip={t("nav.help")}
                label={t("nav.help")}
                className={activeNavigation === "help" ? "active" : ""}
                onClick={() => navigate("/help")}
              >
                <CircleHelp size={17} aria-hidden />
              </UiIconButton>
              <LocaleSwitcher locale={locale} onChange={changeLocale} t={t} />
              {authUser ? (
                <TopbarAccountControls
                  displayName={authUser.display_name}
                  onLogout={handleLogout}
                  t={t}
                />
              ) : routeHandle.page !== "signin" ? (
                <UiButton variant="primary" onClick={() => navigate("/signin")}>
                  {t("nav.signIn")}
                </UiButton>
              ) : null}
            </div>
          </nve-page-header>
          {error && <div slot="subheader" className="error-banner" role="alert">{error}</div>}
          <section
            id="app-main-content"
            ref={contentRef}
            tabIndex={-1}
            className={`app-content ${onWorkspaceRoute ? "workspace-content" : "page-content"}`}
          >
            <Suspense
              fallback={
                onWorkspaceRoute ? (
                  <WorkspaceContentSkeleton label={t("common.loading")} />
                ) : (
                  <PageContentSkeleton label={t("common.loading")} />
                )
              }
            >
              <Outlet />
            </Suspense>
          </section>
      </nve-page>
      <UiDialog
        open={reloadRequired}
        closable={false}
        title={t("compatibility.reloadTitle")}
        description={t("compatibility.reloadDescription")}
        onClose={() => undefined}
        actions={
          <UiButton variant="primary" onClick={() => window.location.reload()}>
            {t("compatibility.reloadAction")}
          </UiButton>
        }
      />
    </AppContext.Provider>
  );
}
