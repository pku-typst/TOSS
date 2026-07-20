import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import "@/pages/projects.css";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowRight,
  Copy,
  Download,
  FileUp,
  LayoutTemplate,
  Pencil,
  Plus
} from "lucide-react";
import { ProviderBrandMark } from "@/components/ProviderBrandMark";
import {
  UiBadge,
  UiButton,
  UiCard,
  UiDialog,
  UiEmptyState,
  UiIconButton,
  UiInput,
  UiPageHeading,
  UiSectionHeading,
  UiSelect
} from "@/components/ui";
import type {
  ExternalGitProvider,
  OrganizationMembership,
  Project,
} from "@/lib/api";
import { formatDateTime, type Translator, type UiLocale } from "@/lib/i18n";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type { ProjectCopyDialogState, ProjectRenameDialogState } from "@/types/project-ui";
import { ExternalGitImportDialog } from "@/pages/projects/ExternalGitImportDialog";
import { PptxImportDialog } from "@/pages/projects/PptxImportDialog";
import { usePptxImport } from "@/pages/processing/usePptxImport";
import { useProjectCatalog } from "@/projects/projectCatalog";

function ProjectThumbnail({
  project,
  t
}: {
  project: Project;
  t: Translator;
}) {
  const projectCatalog = useProjectCatalog();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    if (!project.has_thumbnail) {
      setSrc(null);
      return () => undefined;
    }
    projectCatalog
      .loadThumbnail(project)
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .then((next) => {
        if (cancelled) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next || "";
        setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [project, projectCatalog]);

  if (!src) {
    return (
      <div className="project-thumb placeholder" aria-label={t("workspace.preview")}>
        PDF
      </div>
    );
  }

  return <img className="project-thumb loaded" src={src} alt={project.name} loading="lazy" />;
}

type ProjectRowProps = {
  project: Project;
  busyProjectId: string | null;
  onOpenProject: (project: Project) => void;
  onOpenRenameDialog: (project: Project) => void;
  onOpenCopyDialog: (project: Project) => void;
  onToggleProjectArchived: (project: Project) => Promise<void>;
  showProjectType: boolean;
  locale: UiLocale;
  t: Translator;
};

function ProjectRow({
  project,
  busyProjectId,
  onOpenProject,
  onOpenRenameDialog,
  onOpenCopyDialog,
  onToggleProjectArchived,
  showProjectType,
  locale,
  t
}: ProjectRowProps) {
  return (
    <div className="projects-row" key={project.id}>
      <nve-button
        className="project-title-cell"
        role="button"
        container="flat"
        data-action="open-project"
        onClick={() => onOpenProject(project)}
      >
        <div className="project-title-content">
          <ProjectThumbnail project={project} t={t} />
          <div className="project-main">
            <strong>{project.name}</strong>
            <div className="project-tags">
              {showProjectType && (
                <UiBadge tone={project.project_type === "latex" ? "success" : "neutral"}>
                  {project.project_type === "latex"
                    ? t("settings.projectTypeLatex")
                    : t("settings.projectTypeTypst")}
                </UiBadge>
              )}
              {project.is_template && <UiBadge tone="accent">{t("projects.templateBadge")}</UiBadge>}
              {!project.can_read && <UiBadge tone="warning">{t("projects.templateUseOnly")}</UiBadge>}
            </div>
          </div>
        </div>
      </nve-button>
      <div className="project-owner-cell">
        <span className="project-meta-label">{t("projects.tableOwner")}</span>
        <span className="project-meta-value">{project.owner_display_name}</span>
      </div>
      <div className="project-edited-cell" title={formatDateTime(locale, project.last_edited_at)}>
        <span className="project-meta-label">{t("projects.tableLastEdited")}</span>
        <span className="project-meta-value">{formatRelativeTime(project.last_edited_at, locale)}</span>
      </div>
      <div className="projects-row-actions">
        <UiIconButton
          tooltip={t("projects.open")}
          label={t("projects.open")}
          onClick={() => onOpenProject(project)}
        >
          <ArrowRight size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={t("projects.rename")}
          label={t("projects.rename")}
          onClick={() => onOpenRenameDialog(project)}
        >
          <Pencil size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={t("projects.copy")}
          label={t("projects.copy")}
          onClick={() => onOpenCopyDialog(project)}
        >
          <Copy size={16} />
        </UiIconButton>
        <UiIconButton
          tooltip={project.archived ? t("projects.unarchive") : t("projects.archive")}
          label={project.archived ? t("projects.unarchive") : t("projects.archive")}
          disabled={busyProjectId === project.id}
          onClick={() => onToggleProjectArchived(project)}
        >
          <Archive size={16} />
        </UiIconButton>
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string, locale: UiLocale) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const diffMs = Date.now() - at;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const rawValue =
    abs < hour
      ? Math.round(abs / minute)
      : abs < day
        ? Math.round(abs / hour)
        : abs < week
          ? Math.round(abs / day)
          : abs < month
            ? Math.round(abs / week)
            : abs < year
              ? Math.round(abs / month)
              : Math.round(abs / year);
  const value = Math.max(1, rawValue);
  const unit =
    abs < hour
      ? "minute"
      : abs < day
        ? "hour"
        : abs < week
          ? "day"
          : abs < month
            ? "week"
            : abs < year
              ? "month"
              : "year";
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto"
  });
  return formatter.format(diffMs >= 0 ? -value : value, unit as Intl.RelativeTimeFormatUnit);
}

function updateRenameDialogName(
  value: string,
  setRenameDialog: Dispatch<SetStateAction<ProjectRenameDialogState | null>>
) {
  setRenameDialog((current) =>
    current
      ? {
          ...current,
          nextName: value
        }
      : current
  );
}

function updateCopyDialogName(
  value: string,
  setCopyDialog: Dispatch<SetStateAction<ProjectCopyDialogState | null>>
) {
  setCopyDialog((current) =>
    current
      ? {
          ...current,
          suggestedName: value
        }
      : current
  );
}

type NewProjectNameIssue = "required" | "duplicate";

function normalizedProjectName(value: string) {
  return value.trim().toLowerCase();
}

function newProjectNameIssue(name: string, projects: Project[]): NewProjectNameIssue | null {
  const normalizedName = normalizedProjectName(name);
  if (!normalizedName) return "required";
  return projects.some(
    (project) => !project.is_template && normalizedProjectName(project.name) === normalizedName
  )
    ? "duplicate"
    : null;
}

export function ProjectsPage({
  projects,
  organizations,
  enabledProjectTypes,
  externalGitProviders,
  processingUserId,
  refreshProjects,
  locale,
  t
}: {
  projects: Project[];
  organizations: OrganizationMembership[];
  enabledProjectTypes: ProjectType[];
  externalGitProviders: ExternalGitProvider[];
  processingUserId?: string;
  refreshProjects: () => Promise<void>;
  locale: UiLocale;
  t: Translator;
}) {
  const projectCatalog = useProjectCatalog();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [nameValidationRequested, setNameValidationRequested] = useState(false);
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);
  const [newProjectType, setNewProjectType] = useState<"typst" | "latex">("typst");
  const [newLatexEngine, setNewLatexEngine] = useState<"pdftex" | "xetex">("xetex");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [renameDialog, setRenameDialog] = useState<ProjectRenameDialogState | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalGitImportDialogOpen, setExternalGitImportDialogOpen] = useState(false);
  const [pptxImportDialogOpen, setPptxImportDialogOpen] = useState(false);
  const pptxImport = usePptxImport({
    userId: processingUserId ?? null,
    enabled: !!processingUserId
  });
  const latexEnabled = enabledProjectTypes.includes("latex");
  const showProjectType = enabledProjectTypes.length > 1;
  const nameIssue = nameValidationRequested ? newProjectNameIssue(name, projects) : null;

  useEffect(() => {
    if (!latexEnabled && newProjectType !== "typst") {
      setNewProjectType("typst");
    }
  }, [latexEnabled, newProjectType]);
  const filteredProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return projects
      .filter((project) => !project.is_template)
      .filter((project) => (view === "archived" ? project.archived : !project.archived))
      .filter((project) => {
        if (!keyword) return true;
        return (
          project.name.toLowerCase().includes(keyword) ||
          project.owner_display_name.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => Date.parse(b.last_edited_at) - Date.parse(a.last_edited_at));
  }, [projects, search, view]);

  async function createFromCopy() {
    if (!copyDialog || !copyDialog.suggestedName.trim()) return;
    try {
      setCopyBusy(true);
      setError(null);
      const created = await projectCatalog.copy(copyDialog.projectId, { name: copyDialog.suggestedName.trim() });
      setCopyDialog(null);
      await refreshProjects();
      navigate(`/project/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.copyFailed"));
    } finally {
      setCopyBusy(false);
    }
  }

  async function submitRename() {
    if (!renameDialog || !renameDialog.nextName.trim()) return;
    try {
      setRenameBusy(true);
      setError(null);
      await projectCatalog.rename(renameDialog.projectId, renameDialog.nextName.trim());
      setRenameDialog(null);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.renameFailed"));
    } finally {
      setRenameBusy(false);
    }
  }

  function openProject(project: Project) {
    navigate(`/project/${project.id}`);
  }

  function openRenameDialog(project: Project) {
    setRenameDialog({
      projectId: project.id,
      sourceName: project.name,
      nextName: project.name
    });
  }

  function openCopyDialog(project: Project) {
    setCopyDialog({
      projectId: project.id,
      sourceName: project.name,
      suggestedName: `${project.name} ${t("projects.copySuffix")}`
    });
  }

  async function toggleProjectArchived(project: Project) {
    try {
      setError(null);
      setBusyProjectId(project.id);
      await projectCatalog.setArchived(project.id, !project.archived);
      await refreshProjects();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : project.archived
            ? t("projects.unarchiveFailed")
            : t("projects.archiveFailed");
      setError(message);
    } finally {
      setBusyProjectId(null);
    }
  }

  async function createNamedProject() {
    const normalizedName = name.trim();
    if (newProjectNameIssue(name, projects)) {
      setError(null);
      setNameValidationRequested(true);
      projectNameInputRef.current?.focus();
      return;
    }
    try {
      setError(null);
      await projectCatalog.create({
        name: normalizedName,
        project_type: newProjectType,
        latex_engine: newProjectType === "latex" ? newLatexEngine : undefined
      });
      setName("");
      setNameValidationRequested(false);
      await refreshProjects();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("projects.createFailed");
      setError(message);
    }
  }

  return (
    <section className="app-page" nve-layout="column gap:lg pad:md @md|pad:xl">
      <UiPageHeading title={t("projects.title")} />
      <UiCard className="projects-create-card" accented>
        <UiSectionHeading
          className="projects-create-heading"
          headingLevel={2}
          title={t("projects.createTitle")}
          actions={
            <div nve-layout="row gap:xs align:vertical-center align:wrap">
              {externalGitProviders.length > 0 && (
                <UiButton
                  variant="ghost"
                  onClick={() => setExternalGitImportDialogOpen(true)}
                  data-provider-brand={
                    externalGitProviders.length === 1
                      ? externalGitProviders[0]?.brand
                      : undefined
                  }
                >
                  {externalGitProviders.length === 1 && externalGitProviders[0] ? (
                    <ProviderBrandMark
                      brand={externalGitProviders[0].brand}
                      size={24}
                      className="projects-import-provider-mark"
                    />
                  ) : (
                    <Download size={16} aria-hidden />
                  )}
                  {t("externalGit.importFrom", {
                    provider:
                      externalGitProviders.length === 1
                        ? externalGitProviders[0]?.display_name ?? t("externalGit.providerGeneric")
                        : t("externalGit.providerGeneric")
                  })}
                </UiButton>
              )}
              {pptxImport.visible && (
                <UiButton
                  variant="ghost"
                  onClick={() => {
                    pptxImport.reset();
                    setPptxImportDialogOpen(true);
                  }}
                >
                  <FileUp size={16} aria-hidden />
                  {t("processing.importPptx")}
                </UiButton>
              )}
              <UiButton variant="ghost" onClick={() => navigate("/gallery")}>
                <LayoutTemplate size={16} aria-hidden />
                {t("projects.browseTemplates")}
              </UiButton>
            </div>
          }
        />
        <div nve-layout="grid gap:sm align:vertical-stretch">
          <div
            nve-layout={`span:12 @md|span:${
              !latexEnabled ? "10" : newProjectType === "latex" ? "6" : "7"
            }`}
          >
            <UiInput
              ref={projectNameInputRef}
              name="project-name"
              label={t("projects.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("projects.namePlaceholder")}
              required
              error={
                nameIssue === "required"
                  ? t("projects.nameRequired")
                  : nameIssue === "duplicate"
                    ? t("projects.nameDuplicate")
                    : undefined
              }
            />
          </div>
          {latexEnabled && (
            <div nve-layout={`span:12 @md|span:${newProjectType === "latex" ? "2" : "3"}`}>
              <UiSelect
                label={t("settings.projectType")}
                value={newProjectType}
                onChange={(e) =>
                  setNewProjectType(e.target.value === "latex" ? "latex" : "typst")
                }
              >
                <option value="typst">{t("settings.projectTypeTypst")}</option>
                <option value="latex">{t("settings.projectTypeLatex")}</option>
              </UiSelect>
            </div>
          )}
          {latexEnabled && newProjectType === "latex" && (
            <div nve-layout="span:12 @md|span:2">
              <UiSelect
                label={t("settings.latexEngine")}
                value={newLatexEngine}
                onChange={(e) => setNewLatexEngine(e.target.value === "pdftex" ? "pdftex" : "xetex")}
              >
                <option value="xetex">XeTeX</option>
                <option value="pdftex">pdfTeX</option>
              </UiSelect>
            </div>
          )}
          <div nve-layout="span:12 @md|span:2 column align:right align:bottom">
            <UiButton
              variant="primary"
              data-action="create-project"
              onClick={createNamedProject}
            >
              <Plus size={16} />
              <span>{t("projects.createAction")}</span>
            </UiButton>
          </div>
        </div>
      </UiCard>
      <UiCard
        className="projects-filter-card"
        contentLayout="column gap:sm pad:lg align:horizontal-stretch"
      >
        <UiInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("projects.searchPlaceholder")}
          aria-label={t("projects.searchPlaceholder")}
        />
        <div nve-layout="row gap:xs align:vertical-center">
          <UiButton variant={view === "active" ? "primary" : "secondary"} onClick={() => setView("active")}>
            {t("projects.active")}
          </UiButton>
          <UiButton variant={view === "archived" ? "primary" : "secondary"} onClick={() => setView("archived")}>
            {t("projects.archived")}
          </UiButton>
        </div>
      </UiCard>
      <UiCard
        className="projects-table-card"
        contentLayout="column gap:sm pad:lg align:horizontal-stretch"
      >
        <div className="projects-grid-header">
          <span>{t("projects.tableTitle")}</span>
          <span>{t("projects.tableOwner")}</span>
          <span>{t("projects.tableLastEdited")}</span>
          <span>{t("projects.tableActions")}</span>
        </div>
        <div className="projects-list">
          {filteredProjects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              busyProjectId={busyProjectId}
              onOpenProject={openProject}
              onOpenRenameDialog={openRenameDialog}
              onOpenCopyDialog={openCopyDialog}
              onToggleProjectArchived={toggleProjectArchived}
              showProjectType={showProjectType}
              locale={locale}
              t={t}
            />
          ))}
          {filteredProjects.length === 0 && <UiEmptyState description={t("projects.empty")} />}
        </div>
      </UiCard>
      <UiCard className="projects-organizations-card">
        <UiSectionHeading headingLevel={2} title={t("projects.organizations")} />
        <div nve-layout="row gap:xs align:vertical-center align:wrap">
          {organizations.length > 0 ? (
            organizations.map((org) => (
              <UiBadge key={org.organization_id} tone="neutral">
                {org.organization_name}
              </UiBadge>
            ))
          ) : (
            <span nve-text="body muted">{t("projects.noOrganizations")}</span>
          )}
        </div>
      </UiCard>
      <UiDialog
        open={!!renameDialog}
        title={t("projects.renameDialogTitle")}
        description={renameDialog ? `${t("projects.renameDialogHint")} ${renameDialog.sourceName}` : undefined}
        onClose={() => setRenameDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setRenameDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton variant="primary" onClick={submitRename} disabled={renameBusy || !renameDialog?.nextName.trim()}>
              {renameBusy ? t("projects.renaming") : t("projects.renameAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          label={t("projects.namePlaceholder")}
          value={renameDialog?.nextName ?? ""}
          onChange={(e) => updateRenameDialogName(e.target.value, setRenameDialog)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
      <UiDialog
        open={!!copyDialog}
        title={t("projects.copyDialogTitle")}
        description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
        onClose={() => setCopyDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setCopyDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton variant="primary" onClick={createFromCopy} disabled={copyBusy || !copyDialog?.suggestedName.trim()}>
              {copyBusy ? t("projects.copying") : t("projects.copyAction")}
            </UiButton>
          </>
        }
      >
        <UiInput
          label={t("projects.namePlaceholder")}
          value={copyDialog?.suggestedName ?? ""}
          onChange={(e) => updateCopyDialogName(e.target.value, setCopyDialog)}
          placeholder={t("projects.namePlaceholder")}
        />
      </UiDialog>
      {error && (
        <nve-alert status="danger" role="alert">
          <span>{error}</span>
        </nve-alert>
      )}
      {externalGitProviders.length > 0 && (
        <ExternalGitImportDialog
          open={externalGitImportDialogOpen}
          providers={externalGitProviders}
          enabledProjectTypes={enabledProjectTypes}
          onClose={() => {
            setExternalGitImportDialogOpen(false);
            void refreshProjects();
          }}
          onComplete={async (projectId) => {
            await refreshProjects();
            setExternalGitImportDialogOpen(false);
            navigate(`/project/${projectId}`);
          }}
          t={t}
        />
      )}
      {pptxImport.visible && (
        <PptxImportDialog
          open={pptxImportDialogOpen}
          state={pptxImport.state}
          reason={pptxImport.reason}
          pending={pptxImport.pending}
          error={pptxImport.error}
          onClose={() => setPptxImportDialogOpen(false)}
          onSubmit={(file, mode) => pptxImport.submit({ file, mode })}
          t={t}
        />
      )}
    </section>
  );
}
