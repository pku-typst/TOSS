import { UiButton } from "@/components/ui";
import {
  Eye,
  FileText,
  FolderOpen,
  History,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Pencil,
  Settings,
  UserRound
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import type { Translator, UiLocale } from "@/lib/i18n";
import type {
  WorkspaceOptionalPanelDescriptor,
  WorkspacePanelView
} from "@/pages/workspace/types";

export function WorkspaceToolbar({
  projectId,
  projectName,
  showFilesPanel,
  showPreviewPanel,
  showProjectSettingsPanel,
  showRevisionPanel,
  optionalAuxiliaryPanels,
  collapsePanelsIntoMenu,
  singlePanelMode,
  activePanel,
  onRenameProject,
  canRenameProject,
  onTogglePanel,
  onSelectPanel,
  showAccountControlsInViewMenu,
  accountDisplayName,
  onOpenProfile,
  onLogout,
  readOnly,
  locale,
  onLocaleChange,
  t
}: {
  projectId: string;
  projectName: string;
  showFilesPanel: boolean;
  showPreviewPanel: boolean;
  showProjectSettingsPanel: boolean;
  showRevisionPanel: boolean;
  optionalAuxiliaryPanels: readonly WorkspaceOptionalPanelDescriptor[];
  collapsePanelsIntoMenu: boolean;
  singlePanelMode: boolean;
  activePanel: WorkspacePanelView;
  onRenameProject: (nextName: string) => Promise<boolean>;
  canRenameProject: boolean;
  onTogglePanel: (panel: Exclude<WorkspacePanelView, "editor">) => void;
  onSelectPanel: (panel: WorkspacePanelView) => void;
  showAccountControlsInViewMenu: boolean;
  accountDisplayName: string | null;
  onOpenProfile: () => void;
  onLogout: () => void;
  readOnly: boolean;
  locale: UiLocale;
  onLocaleChange: (locale: UiLocale) => void;
  t: Translator;
}) {
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName);
  const [renameBusy, setRenameBusy] = useState(false);
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);
  const renameInFlightRef = useRef(false);
  const ignoreNextBlurRef = useRef(false);
  const viewMenuId = "workspace-view-menu-" + projectId;
  const closePopover = (id: string) => document.getElementById(id)?.hidePopover();

  useEffect(() => {
    if (!editingProjectName) {
      setProjectNameDraft(projectName);
    }
  }, [editingProjectName, projectName]);

  useEffect(() => {
    if (!editingProjectName) return;
    projectNameInputRef.current?.focus();
    projectNameInputRef.current?.select();
  }, [editingProjectName]);

  function beginProjectRename() {
    if (!canRenameProject) return;
    setProjectNameDraft(projectName);
    setEditingProjectName(true);
  }

  function cancelProjectRename() {
    setProjectNameDraft(projectName);
    setEditingProjectName(false);
  }

  async function commitProjectRename() {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    if (renameInFlightRef.current) return;

    const nextName = projectNameDraft.trim();
    if (!nextName || nextName === projectName) {
      setProjectNameDraft(projectName);
      setEditingProjectName(false);
      return;
    }

    renameInFlightRef.current = true;
    setRenameBusy(true);
    try {
      if (await onRenameProject(nextName)) {
        setEditingProjectName(false);
      } else {
        requestAnimationFrame(() => projectNameInputRef.current?.focus());
      }
    } finally {
      renameInFlightRef.current = false;
      setRenameBusy(false);
    }
  }

  function handleProjectNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      ignoreNextBlurRef.current = true;
      event.currentTarget.blur();
      cancelProjectRename();
    }
  }

  return (
    <div className="workspace-topbar-controls">
      <div className="workspace-project-title-wrap">
        {editingProjectName ? (
          <div className="workspace-project-title-editor">
            <input
              ref={projectNameInputRef}
              className="workspace-project-title-input"
              value={projectNameDraft}
              onChange={(event) => setProjectNameDraft(event.target.value)}
              onKeyDown={handleProjectNameKeyDown}
              onBlur={() => void commitProjectRename()}
              aria-label={t("projects.rename")}
              disabled={renameBusy}
              spellCheck={false}
            />
            {renameBusy && <LoaderCircle className="workspace-project-title-spinner" size={14} aria-hidden />}
          </div>
        ) : canRenameProject ? (
          <button
            type="button"
            className="workspace-project-title-button"
            onClick={beginProjectRename}
            aria-label={`${t("projects.rename")}: ${projectName}`}
            title={t("projects.rename")}
          >
            <span className="workspace-project-title">{projectName || t("common.loading")}</span>
            <Pencil className="workspace-project-edit-icon" size={13} aria-hidden />
          </button>
        ) : (
          <span className="workspace-project-title-static">
            <span className="workspace-project-title">{projectName || t("common.loading")}</span>
          </span>
        )}
        {readOnly && <span className="workspace-project-readonly">{t("workspace.readOnlyTag")}</span>}
      </div>
      <div className="workspace-icon-toggles">
        {collapsePanelsIntoMenu ? (
          <div className="workspace-view-menu-wrap">
            <nve-button
              className="icon-toggle"
              role="button"
              container="flat"
              aria-label={t("workspace.view")}
              title={t("workspace.view")}
              aria-haspopup="menu"
              popovertarget={viewMenuId}
            >
              <LayoutGrid size={14} aria-hidden />
              <span>{t("workspace.view")}</span>
            </nve-button>
            <nve-dropdown
              id={viewMenuId}
              className="workspace-view-dropdown"
              position="bottom"
              alignment="end"
            >
              <nve-menu className="workspace-view-menu">
                {singlePanelMode && (
                  <nve-menu-item
                    role="menuitem"
                    current={activePanel === "editor" ? "page" : undefined}
                    onClick={() => {
                      closePopover(viewMenuId);
                      onSelectPanel("editor");
                    }}
                  >
                    <FileText size={14} aria-hidden />
                    <span>{t("workspace.editor")}</span>
                  </nve-menu-item>
                )}
                <nve-menu-item
                  role="menuitem"
                  current={showFilesPanel ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onTogglePanel("files");
                  }}
                >
                  <FolderOpen size={14} aria-hidden />
                  <span>{t("workspace.files")}</span>
                </nve-menu-item>
                <nve-menu-item
                  role="menuitem"
                  current={showPreviewPanel ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onTogglePanel("preview");
                  }}
                >
                  <Eye size={14} aria-hidden />
                  <span>{t("workspace.preview")}</span>
                </nve-menu-item>
                {optionalAuxiliaryPanels.map((control) => (
                  <nve-menu-item
                    key={control.panel}
                    role="menuitem"
                    current={control.active ? "page" : undefined}
                    onClick={() => {
                      closePopover(viewMenuId);
                      onTogglePanel(control.panel);
                    }}
                  >
                    {control.icon}
                    <span>{control.label}</span>
                  </nve-menu-item>
                ))}
                <nve-menu-item
                  role="menuitem"
                  current={showProjectSettingsPanel ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onTogglePanel("settings");
                  }}
                >
                  <Settings size={14} aria-hidden />
                  <span>{t("workspace.settings")}</span>
                </nve-menu-item>
                <nve-menu-item
                  role="menuitem"
                  current={showRevisionPanel ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onTogglePanel("revisions");
                  }}
                >
                  <History size={14} aria-hidden />
                  <span>{t("workspace.revisions")}</span>
                </nve-menu-item>
                <nve-divider />
                <nve-menu-item
                  role="menuitemradio"
                  current={locale === "en" ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onLocaleChange("en");
                  }}
                >
                  <span>{t("language.english")}</span>
                </nve-menu-item>
                <nve-menu-item
                  role="menuitemradio"
                  current={locale === "zh-CN" ? "page" : undefined}
                  onClick={() => {
                    closePopover(viewMenuId);
                    onLocaleChange("zh-CN");
                  }}
                >
                  <span>{t("language.chineseSimplified")}</span>
                </nve-menu-item>
                {showAccountControlsInViewMenu && (
                  <>
                    <nve-divider />
                    <nve-menu-item
                      role="menuitem"
                      onClick={() => {
                        closePopover(viewMenuId);
                        onOpenProfile();
                      }}
                    >
                      <UserRound size={14} aria-hidden />
                      <span>{accountDisplayName || t("nav.profile")}</span>
                    </nve-menu-item>
                    <nve-menu-item
                      role="menuitem"
                      status="danger"
                      onClick={() => {
                        closePopover(viewMenuId);
                        onLogout();
                      }}
                    >
                      <LogOut size={14} aria-hidden />
                      <span>{t("nav.logout")}</span>
                    </nve-menu-item>
                  </>
                )}
              </nve-menu>
            </nve-dropdown>
          </div>
        ) : (
          <>
            <UiButton
              className={`icon-toggle ${showFilesPanel ? "active" : ""}`}
              aria-label={t("workspace.files")}
              title={t("workspace.files")}
              onClick={() => onTogglePanel("files")}
            >
              <FolderOpen size={14} aria-hidden />
              <span>{t("workspace.files")}</span>
            </UiButton>
            <UiButton
              className={`icon-toggle ${showPreviewPanel ? "active" : ""}`}
              aria-label={t("workspace.preview")}
              title={t("workspace.preview")}
              onClick={() => onTogglePanel("preview")}
            >
              <Eye size={14} aria-hidden />
              <span>{t("workspace.preview")}</span>
            </UiButton>
            {optionalAuxiliaryPanels.map((control) => (
              <UiButton
                key={control.panel}
                className={`icon-toggle ${control.active ? "active" : ""}`}
                aria-label={control.label}
                title={control.label}
                onClick={() => onTogglePanel(control.panel)}
              >
                {control.icon}
                <span>{control.label}</span>
              </UiButton>
            ))}
            <UiButton
              className={`icon-toggle ${showProjectSettingsPanel ? "active" : ""}`}
              aria-label={t("workspace.settings")}
              title={t("workspace.settings")}
              onClick={() => onTogglePanel("settings")}
            >
              <Settings size={14} aria-hidden />
              <span>{t("workspace.settings")}</span>
            </UiButton>
            <UiButton
              className={`icon-toggle ${showRevisionPanel ? "active" : ""}`}
              aria-label={t("workspace.revisions")}
              title={t("workspace.revisions")}
              onClick={() => onTogglePanel("revisions")}
            >
              <History size={14} aria-hidden />
              <span>{t("workspace.revisions")}</span>
            </UiButton>
          </>
        )}
      </div>
    </div>
  );
}
