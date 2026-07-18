import { useEffect, useMemo, useState, type ReactNode } from "react";
import "@/pages/workspace/settings.css";
import {
  Building2,
  Check,
  Copy,
  Cpu,
  Database,
  GitBranch,
  LayoutTemplate,
  Link2,
  Settings2,
  Share2,
  UserRound,
  UsersRound
} from "lucide-react";
import {
  UiBadge,
  UiButton,
  UiCard,
  UiHelpTooltip,
  UiIconButton,
  UiSectionHeading,
  UiSelect,
  UiTooltip
} from "@/components/ui";
import type {
  ExternalGitProvider,
  OrganizationMembership,
  ProjectAccessType,
  ProjectAccessUser,
  ProjectAccessSource,
  ProjectOrganizationAccess,
  ProjectPermission,
  ProjectRole,
  ProjectShareLink
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import type {
  WorkspaceOptionalSettingsSectionDescriptor,
  WorkspaceSettingsSectionId
} from "@/pages/workspace/types";
import { ExternalGitSettingsCard } from "./ExternalGitSettingsCard";

const SETTINGS_SECTION_STORAGE_KEY = "toss.workspace-settings-section";

function readStoredSettingsSection(): string | null {
  try {
    return window.localStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  return null;
}

function storeSettingsSection(section: WorkspaceSettingsSectionId) {
  try {
    window.localStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, section);
  } catch {
    // Navigation still works when storage is unavailable.
  }
}

type ShareLinkCardProps = {
  title: string;
  activeShare: ProjectShareLink | null;
  canManageProject: boolean;
  copiedControl: string | null;
  copyControlKey: string;
  windowOrigin: string;
  onCreate: () => Promise<void>;
  onRevoke: (shareLinkId: string) => Promise<void>;
  onCopyToClipboard: (controlKey: string, value: string) => Promise<void>;
  t: Translator;
};

function ShareLinkCard({
  title,
  activeShare,
  canManageProject,
  copiedControl,
  copyControlKey,
  windowOrigin,
  onCreate,
  onRevoke,
  onCopyToClipboard,
  t
}: ShareLinkCardProps) {
  const linkValue = activeShare ? `${windowOrigin}/share/${activeShare.token_value}` : "";
  return (
    <UiCard className="settings-subcard share-link-card" contentLayout="column gap:sm pad:md align:horizontal-stretch">
      <div className="settings-subcard-heading">
        <span className={`settings-status-icon ${activeShare ? "is-active" : ""}`}>
          <Link2 size={15} aria-hidden />
        </span>
        <strong>{title}</strong>
        {canManageProject &&
          (activeShare ? (
            <UiButton size="sm" onClick={() => onRevoke(activeShare.id)}>
              {t("common.disable")}
            </UiButton>
          ) : (
            <UiButton size="sm" onClick={onCreate}>
              {t("common.enable")}
            </UiButton>
          ))}
      </div>
      {linkValue ? (
        <div className="settings-copy-field">
          <code className="settings-code">{linkValue}</code>
          <UiIconButton
            tooltip={copiedControl === copyControlKey ? t("share.copied") : t("share.copy")}
            label={copiedControl === copyControlKey ? t("share.copied") : t("share.copy")}
            onClick={() => onCopyToClipboard(copyControlKey, linkValue)}
          >
            {copiedControl === copyControlKey ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
          </UiIconButton>
        </div>
      ) : (
        <small className="settings-empty-copy">{t("share.none")}</small>
      )}
    </UiCard>
  );
}

export function SettingsPanel({
  width,
  projectId,
  projectName,
  projectType,
  typstPreviewRenderer,
  latexEngine,
  entryFilePath,
  typEntryOptions,
  canManageProject,
  canViewWriteShareLink,
  projectAccessEnabled,
  externalRepositoriesEnabled,
  externalGitProviders,
  gitRepoUrl,
  copiedControl,
  templateEnabled,
  myOrganizations,
  projectOrgAccess,
  projectAccessUsers,
  error,
  entryFilePending,
  latexEnginePending,
  onEntryFileChange,
  onLatexEngineChange,
  onTypstPreviewRendererChange,
  onCopyToClipboard,
  onToggleTemplate,
  activeReadShare,
  activeWriteShare,
  onCreateShare,
  onRevokeShare,
  onGrantOrgAccess,
  onRevokeOrgAccess,
  formatAccessType,
  formatRoleLabel,
  formatAccessSource,
  optionalSections = [],
  preferredSection,
  t
}: {
  width: number;
  projectId: string;
  projectName: string;
  projectType: "typst" | "latex";
  typstPreviewRenderer: "pdf" | "canvas";
  latexEngine: "pdftex" | "xetex";
  entryFilePath: string;
  typEntryOptions: string[];
  canManageProject: boolean;
  canViewWriteShareLink: boolean;
  projectAccessEnabled: boolean;
  externalRepositoriesEnabled: boolean;
  externalGitProviders: ExternalGitProvider[];
  gitRepoUrl: string;
  copiedControl: string | null;
  templateEnabled: boolean;
  myOrganizations: OrganizationMembership[];
  projectOrgAccess: ProjectOrganizationAccess[];
  projectAccessUsers: ProjectAccessUser[];
  error: string | null;
  entryFilePending: boolean;
  latexEnginePending: boolean;
  onEntryFileChange: (path: string) => Promise<void>;
  onLatexEngineChange: (engine: "pdftex" | "xetex") => Promise<void>;
  onTypstPreviewRendererChange: (mode: "pdf" | "canvas") => void;
  onCopyToClipboard: (controlKey: string, value: string) => Promise<void>;
  onToggleTemplate: () => Promise<void>;
  activeReadShare: ProjectShareLink | null;
  activeWriteShare: ProjectShareLink | null;
  onCreateShare: (permission: ProjectPermission) => Promise<void>;
  onRevokeShare: (shareLinkId: string) => Promise<void>;
  onGrantOrgAccess: (organizationId: string, permission: ProjectPermission) => Promise<void>;
  onRevokeOrgAccess: (organizationId: string) => Promise<void>;
  formatAccessType: (accessType: ProjectAccessType, role: ProjectRole) => string;
  formatRoleLabel: (role: ProjectRole) => string;
  formatAccessSource: (source: ProjectAccessSource) => string;
  optionalSections?: readonly WorkspaceOptionalSettingsSectionDescriptor[];
  preferredSection?: WorkspaceSettingsSectionId | null;
  t: Translator;
}) {
  const windowOrigin = window.location.origin;
  const sections = useMemo<Array<{
    id: WorkspaceSettingsSectionId;
    label: string;
    icon: ReactNode;
  }>>(() => [
    { id: "project", label: t("settings.sectionProject"), icon: <Settings2 size={15} aria-hidden /> },
    ...(externalRepositoriesEnabled
      ? [{ id: "storage" as const, label: t("settings.sectionStorage"), icon: <Database size={15} aria-hidden /> }]
      : []),
    ...(projectAccessEnabled
      ? [{ id: "access" as const, label: t("settings.sectionAccess"), icon: <UsersRound size={15} aria-hidden /> }]
      : []),
    ...optionalSections.map((section) => ({
      id: section.section,
      label: section.label,
      icon: section.icon
    }))
  ], [externalRepositoriesEnabled, optionalSections, projectAccessEnabled, t]);
  const availableSections = useMemo(
    () => new Set(sections.map((section) => section.id)),
    [sections]
  );
  const [activeSection, setActiveSection] = useState<WorkspaceSettingsSectionId>(() => {
    if (preferredSection && availableSections.has(preferredSection)) return preferredSection;
    const stored = readStoredSettingsSection();
    return stored && availableSections.has(stored as WorkspaceSettingsSectionId)
      ? stored as WorkspaceSettingsSectionId
      : "project";
  });

  useEffect(() => {
    if (!availableSections.has(activeSection)) {
      setActiveSection("project");
    }
  }, [activeSection, availableSections]);

  useEffect(() => {
    storeSettingsSection(activeSection);
  }, [activeSection]);

  return (
    <aside className="panel panel-settings" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.settings")}</h2>
      </div>
      <nav className="settings-nav" role="tablist" aria-label={t("settings.navigation")}>
        {sections.map((section) => (
          <UiTooltip content={section.label} className="settings-nav-tooltip" key={section.id}>
            <button
              type="button"
              role="tab"
              id={`settings-tab-${section.id}`}
              aria-controls={`settings-panel-${section.id}`}
              aria-selected={activeSection === section.id}
              aria-label={section.label}
              className={`settings-nav-item ${activeSection === section.id ? "is-active" : ""}`}
              onClick={() => setActiveSection(section.id)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {section.icon}
              </span>
            </button>
          </UiTooltip>
        ))}
      </nav>
      <div className="panel-content settings-panel-content">
        {error && <div className="workspace-error panel-inline-error">{error}</div>}
        {activeSection === "project" && (
          <div
            className="settings-tab-panel"
            id="settings-panel-project"
            role="tabpanel"
            aria-labelledby="settings-tab-project"
          >
            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading
                icon={<Cpu size={18} aria-hidden />}
                title={t("settings.compilation")}
                actions={
                  <span className="settings-heading-actions">
                    <UiBadge tone="accent">
                      {projectType === "typst"
                        ? t("settings.projectTypeTypst")
                        : t("settings.projectTypeLatex")}
                    </UiBadge>
                    <UiHelpTooltip
                      content={
                        projectType === "typst"
                          ? `${t("settings.entryFileHint")} ${t("settings.typstPreviewRendererHint")}`
                          : t("settings.entryFileHint")
                      }
                    />
                  </span>
                }
              />
              {projectType === "latex" && (
                <UiSelect
                  label={t("settings.latexEngine")}
                  value={latexEngine}
                  onChange={async (event) => {
                    const value = event.target.value === "pdftex" ? "pdftex" : "xetex";
                    await onLatexEngineChange(value);
                  }}
                  disabled={!canManageProject || latexEnginePending}
                >
                  <option value="xetex">XeTeX</option>
                  <option value="pdftex">pdfTeX</option>
                </UiSelect>
              )}
              {projectType === "typst" && (
                <UiSelect
                  label={t("settings.typstPreviewRenderer")}
                  value={typstPreviewRenderer}
                  onChange={(event) =>
                    onTypstPreviewRendererChange(event.target.value === "canvas" ? "canvas" : "pdf")
                  }
                >
                  <option value="pdf">{t("settings.typstPreviewRendererPdf")}</option>
                  <option value="canvas">{t("settings.typstPreviewRendererCanvas")}</option>
                </UiSelect>
              )}
              <UiSelect
                label={t("settings.entryFile")}
                value={entryFilePath}
                onChange={async (event) => {
                  const next = event.target.value.trim();
                  if (!next) return;
                  await onEntryFileChange(next);
                }}
                disabled={!canManageProject || entryFilePending}
              >
                {typEntryOptions.map((path) => (
                  <option value={path} key={path}>
                    {path}
                  </option>
                ))}
              </UiSelect>
            </UiCard>

            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading
                icon={<LayoutTemplate size={18} aria-hidden />}
                title={t("settings.templateTitle")}
                actions={<UiHelpTooltip content={t("settings.templateHint")} />}
              />
              <div className="settings-toggle-row">
                <span>
                  <strong>
                    {templateEnabled ? t("settings.templateEnabled") : t("settings.templateDisabled")}
                  </strong>
                </span>
                <UiButton
                  size="sm"
                  variant={templateEnabled ? "primary" : "secondary"}
                  onClick={onToggleTemplate}
                  disabled={!canManageProject}
                >
                  {templateEnabled ? t("common.disable") : t("common.enable")}
                </UiButton>
              </div>
            </UiCard>
          </div>
        )}

        {externalRepositoriesEnabled && activeSection === "storage" && (
          <div
            className="settings-tab-panel"
            id="settings-panel-storage"
            role="tabpanel"
            aria-labelledby="settings-tab-storage"
          >
            <ExternalGitSettingsCard
              projectId={projectId}
              projectName={projectName}
              canManageProject={canManageProject}
              providers={externalGitProviders}
              t={t}
            />

            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading
                icon={<GitBranch size={18} aria-hidden />}
                title={t("settings.gitAccess")}
                actions={<UiHelpTooltip content={t("settings.gitHint")} />}
              />
              <div className="settings-copy-field">
                <code className="settings-code">{gitRepoUrl || t("common.loading")}</code>
                <UiIconButton
                  tooltip={copiedControl === "git-access-url" ? t("share.copied") : t("share.copy")}
                  label={copiedControl === "git-access-url" ? t("share.copied") : t("share.copy")}
                  onClick={() => onCopyToClipboard("git-access-url", gitRepoUrl)}
                  disabled={!gitRepoUrl}
                >
                  {copiedControl === "git-access-url" ? (
                    <Check size={15} aria-hidden />
                  ) : (
                    <Copy size={15} aria-hidden />
                  )}
                </UiIconButton>
              </div>
            </UiCard>
          </div>
        )}

        {projectAccessEnabled && activeSection === "access" && (
          <div
            className="settings-tab-panel"
            id="settings-panel-access"
            role="tabpanel"
            aria-labelledby="settings-tab-access"
          >
            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading icon={<Share2 size={18} aria-hidden />} title={t("share.title")} />
              <div className="settings-subcard-list">
              <ShareLinkCard
                title={t("share.readLink")}
                activeShare={activeReadShare}
                canManageProject={canManageProject}
                copiedControl={copiedControl}
                copyControlKey="share-read-link"
                windowOrigin={windowOrigin}
                onCreate={() => onCreateShare("read")}
                onRevoke={onRevokeShare}
                onCopyToClipboard={onCopyToClipboard}
                t={t}
              />
                {canViewWriteShareLink && (
                  <ShareLinkCard
                    title={t("share.writeLink")}
                    activeShare={activeWriteShare}
                    canManageProject={canManageProject}
                    copiedControl={copiedControl}
                    copyControlKey="share-write-link"
                    windowOrigin={windowOrigin}
                    onCreate={() => onCreateShare("write")}
                    onRevoke={onRevokeShare}
                    onCopyToClipboard={onCopyToClipboard}
                    t={t}
                  />
                )}
              </div>
            </UiCard>

            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading
                icon={<Building2 size={18} aria-hidden />}
                title={t("settings.organizationAccess")}
              />
              {myOrganizations.length > 0 ? (
                <div className="settings-subcard-list">
                  {myOrganizations.map((org) => {
                    const existing = projectOrgAccess.find(
                      (item) => item.organization_id === org.organization_id
                    );
                    return (
                      <div className="settings-organization-row" key={org.organization_id}>
                        <span className="settings-status-icon">
                          <Building2 size={15} aria-hidden />
                        </span>
                        <strong>{org.organization_name}</strong>
                        <UiSelect
                          label={t("settings.accessType")}
                          value={existing?.permission ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (value === "read" || value === "write") {
                              onGrantOrgAccess(org.organization_id, value);
                            } else {
                              onRevokeOrgAccess(org.organization_id);
                            }
                          }}
                          disabled={!canManageProject}
                        >
                          <option value="">{t("settings.noAccess")}</option>
                          <option value="read">{t("settings.readOnly")}</option>
                          <option value="write">{t("settings.readWrite")}</option>
                        </UiSelect>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <small className="settings-empty-copy">{t("projects.noOrganizations")}</small>
              )}
            </UiCard>

            <UiCard className="settings-section-card" contentLayout="column gap:md pad:md align:horizontal-stretch">
              <UiSectionHeading
                icon={<UsersRound size={18} aria-hidden />}
                title={t("settings.projectUsers")}
              />
              {projectAccessUsers.length > 0 ? (
                <div className="settings-user-list">
                  {projectAccessUsers.map((user) => (
                    <div className="settings-user-card" key={`${projectId}-${user.user_id}`}>
                      <span className="settings-user-avatar">
                        <UserRound size={16} aria-hidden />
                      </span>
                      <span className="settings-user-copy">
                        <strong>{user.display_name || user.email}</strong>
                        <small>{user.email}</small>
                        <small>{formatAccessType(user.access_type, user.role)}</small>
                      </span>
                      <UiBadge>{formatRoleLabel(user.role)}</UiBadge>
                      <small className="settings-user-source">
                        {user.sources.map((source) => formatAccessSource(source)).join(", ")}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <small className="settings-empty-copy">{t("settings.noUsers")}</small>
              )}
            </UiCard>
          </div>
        )}
        {optionalSections.map((section) => activeSection === section.section && (
          <div
            className="settings-tab-panel"
            id={`settings-panel-${section.section}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${section.section}`}
            key={section.section}
          >
            {section.content}
          </div>
        ))}
      </div>
    </aside>
  );
}
