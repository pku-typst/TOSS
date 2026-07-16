import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  FileText,
  LayoutTemplate,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  UserRound,
  Users
} from "lucide-react";
import {
  UiBadge,
  UiButton,
  UiCard,
  UiDialog,
  UiHelpTooltip,
  UiIconButton,
  UiInput,
  UiSelect,
  UiTooltip
} from "@/components/ui";
import {
  builtinTemplateThumbnailUrl,
  copyProject,
  createProjectFromBuiltinTemplate,
  listTemplateGallery,
  projectThumbnailUrl,
  updateProjectTemplate,
  type Project,
  type TemplateGalleryItem,
  type TemplateSource
} from "@/lib/api";
import {
  filterGalleryTemplates,
  localizedTemplateText,
  type GallerySourceFilter
} from "@/lib/galleryUtils";
import type { Translator, UiLocale } from "@/lib/i18n";

type GalleryAccentStyle = CSSProperties & { "--gallery-accent": string };

function sourceIcon(source: TemplateSource): ReactNode {
  if (source === "personal") return <UserRound size={16} aria-hidden />;
  if (source === "shared") return <Users size={16} aria-hidden />;
  return <Sparkles size={16} aria-hidden />;
}

function sourceLabel(source: TemplateSource, t: Translator) {
  return t(`gallery.source.${source}`);
}

function categoryLabel(category: string, t: Translator) {
  const key = `gallery.category.${category}`;
  const translated = t(key);
  return translated === key ? category : translated;
}

function TemplateThumbnail({
  template,
  name,
  t
}: {
  template: TemplateGalleryItem;
  name: string;
  t: Translator;
}) {
  const [failed, setFailed] = useState(false);
  if (!template.has_thumbnail || failed) {
    return (
      <div className="gallery-thumbnail gallery-thumbnail-placeholder" aria-label={t("gallery.previewAlt")}>
        <FileText size={42} aria-hidden />
      </div>
    );
  }

  const src =
    template.source === "builtin"
      ? builtinTemplateThumbnailUrl(template.id)
      : projectThumbnailUrl(template.project_id ?? template.id, template.updated_at ?? undefined);
  return (
    <img
      className="gallery-thumbnail"
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function SourceMarker({ source, t }: { source: TemplateSource; t: Translator }) {
  const label = sourceLabel(source, t);
  return (
    <UiTooltip content={label} triggerAriaLabel={label} triggerRole="img">
      <span className={`gallery-source-marker gallery-source-marker-${source}`}>
        {sourceIcon(source)}
      </span>
    </UiTooltip>
  );
}

function TemplateCard({
  template,
  locale,
  t,
  busy,
  onUse,
  onEdit,
  onRemove
}: {
  template: TemplateGalleryItem;
  locale: UiLocale;
  t: Translator;
  busy: boolean;
  onUse: (template: TemplateGalleryItem) => void;
  onEdit: (template: TemplateGalleryItem) => void;
  onRemove: (template: TemplateGalleryItem) => void;
}) {
  const name = localizedTemplateText(template.name, locale);
  const description = localizedTemplateText(template.description, locale);
  const style: GalleryAccentStyle = { "--gallery-accent": template.accent_color };
  return (
    <UiCard className="gallery-card" contentLayout="column gap:md pad:none align:horizontal-stretch" style={style}>
      <div className="gallery-card-visual">
        <TemplateThumbnail
          key={template.updated_at ?? template.id}
          template={template}
          name={name}
          t={t}
        />
        <div className="gallery-card-markers">
          <SourceMarker source={template.source} t={t} />
          {template.featured && (
            <UiTooltip content={t("gallery.featured")} triggerAriaLabel={t("gallery.featured")} triggerRole="img">
              <span className="gallery-featured-marker">
                <Star size={15} fill="currentColor" aria-hidden />
              </span>
            </UiTooltip>
          )}
        </div>
      </div>
      <div className="gallery-card-body">
        <div className="gallery-card-heading">
          <h2>{name}</h2>
          <UiBadge tone="neutral">
            {template.project_type === "latex" ? "LaTeX" : "Typst"}
          </UiBadge>
        </div>
        <p>{description}</p>
        <div className="gallery-card-meta">
          <span>{categoryLabel(template.category, t)}</span>
          {template.owner_display_name && (
            <span>{t("gallery.byOwner", { owner: template.owner_display_name })}</span>
          )}
        </div>
      </div>
      <div className="gallery-card-actions">
        {template.can_edit && template.project_id && (
          <UiButton variant="ghost" onClick={() => onEdit(template)}>
            <Pencil size={15} aria-hidden />
            {t("gallery.editTemplate")}
          </UiButton>
        )}
        <div className="gallery-card-actions-spacer" />
        {template.can_edit && (
          <UiIconButton
            tooltip={t("gallery.removePersonal")}
            label={t("gallery.removePersonal")}
            disabled={busy}
            onClick={() => onRemove(template)}
          >
            <Trash2 size={16} aria-hidden />
          </UiIconButton>
        )}
        <UiButton variant="primary" disabled={busy} onClick={() => onUse(template)}>
          <Plus size={16} aria-hidden />
          {t("gallery.useTemplate")}
        </UiButton>
      </div>
    </UiCard>
  );
}

export function GalleryPage({
  cacheIdentity,
  projects,
  locale,
  t,
  refreshProjects
}: {
  cacheIdentity: string;
  projects: Project[];
  locale: UiLocale;
  t: Translator;
  refreshProjects: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const galleryQueryKey = ["template-gallery", cacheIdentity] as const;
  const galleryQuery = useQuery({
    queryKey: galleryQueryKey,
    queryFn: listTemplateGallery,
    enabled: cacheIdentity.length > 0,
    staleTime: 2 * 60 * 1000
  });
  const templates = useMemo(
    () => galleryQuery.data?.templates ?? [],
    [galleryQuery.data?.templates]
  );
  const loading = galleryQuery.isPending;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<GallerySourceFilter>("all");
  const [category, setCategory] = useState("all");
  const [useDialog, setUseDialog] = useState<TemplateGalleryItem | null>(null);
  const [projectName, setProjectName] = useState("");
  const [createPersonalOpen, setCreatePersonalOpen] = useState(false);
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [removeDialog, setRemoveDialog] = useState<TemplateGalleryItem | null>(null);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);

  const categories = useMemo(
    () => Array.from(new Set(templates.map((template) => template.category))).sort(),
    [templates]
  );
  const visibleTemplates = useMemo(
    () => filterGalleryTemplates(templates, { locale, query, source, category }),
    [category, locale, query, source, templates]
  );
  const eligibleProjects = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.my_role === "Owner" &&
            project.can_read &&
            !project.is_template &&
            !project.archived
        )
        .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [locale, projects]
  );

  function openUseDialog(template: TemplateGalleryItem) {
    setUseDialog(template);
    setProjectName(
      `${localizedTemplateText(template.name, locale)} ${t("gallery.projectSuffix")}`.trim()
    );
  }

  async function useTemplate() {
    if (!useDialog || !projectName.trim()) return;
    try {
      setBusyTemplateId(useDialog.id);
      setError(null);
      const created =
        useDialog.source === "builtin"
          ? await createProjectFromBuiltinTemplate(useDialog.id, { name: projectName.trim() })
          : useDialog.project_id
            ? await copyProject(useDialog.project_id, { name: projectName.trim() })
            : null;
      if (!created) throw new Error(t("gallery.invalidTemplate"));
      setUseDialog(null);
      await refreshProjects();
      navigate(`/project/${created.id}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("gallery.createFailed"));
    } finally {
      setBusyTemplateId(null);
    }
  }

  function openCreatePersonal() {
    setSourceProjectId(eligibleProjects[0]?.id ?? "");
    setCreatePersonalOpen(true);
  }

  async function createPersonalTemplate() {
    if (!sourceProjectId) return;
    try {
      setBusyTemplateId(sourceProjectId);
      setError(null);
      await updateProjectTemplate(sourceProjectId, true);
      setCreatePersonalOpen(false);
      await Promise.all([
        refreshProjects(),
        queryClient.invalidateQueries({ queryKey: galleryQueryKey })
      ]);
      setSource("personal");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("gallery.personalCreateFailed"));
    } finally {
      setBusyTemplateId(null);
    }
  }

  async function removePersonalTemplate() {
    if (!removeDialog?.project_id) return;
    try {
      setBusyTemplateId(removeDialog.id);
      setError(null);
      await updateProjectTemplate(removeDialog.project_id, false);
      setRemoveDialog(null);
      await Promise.all([
        refreshProjects(),
        queryClient.invalidateQueries({ queryKey: galleryQueryKey })
      ]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("gallery.removeFailed"));
    } finally {
      setBusyTemplateId(null);
    }
  }

  return (
    <section className="app-page gallery-page" nve-layout="column gap:lg pad:md @md|pad:xl">
      <header className="gallery-header">
        <div className="gallery-header-icon" aria-hidden>
          <LayoutTemplate size={24} />
        </div>
        <div className="gallery-header-copy">
          <div className="gallery-title-row">
            <h1 nve-text="heading xl">{t("gallery.title")}</h1>
            <UiHelpTooltip content={t("gallery.help")} />
          </div>
          <p>{t("gallery.subtitle")}</p>
        </div>
        <UiButton variant="primary" onClick={openCreatePersonal}>
          <Plus size={16} aria-hidden />
          {t("gallery.createPersonal")}
        </UiButton>
      </header>

      <UiCard className="gallery-toolbar" contentLayout="column gap:sm pad:lg align:horizontal-stretch">
        <div className="gallery-search-row">
          <div className="gallery-search-wrap">
            <UiInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("gallery.search")}
              aria-label={t("gallery.search")}
            />
          </div>
          <UiSelect
            className="gallery-category-select"
            aria-label={t("gallery.category")}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">{t("gallery.category.all")}</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {categoryLabel(item, t)}
              </option>
            ))}
          </UiSelect>
        </div>
        <div className="gallery-source-filters" role="group" aria-label={t("gallery.sourceFilter")}>
          {(["all", "builtin", "personal", "shared"] as const).map((item) => (
            <UiButton
              key={item}
              variant={source === item ? "primary" : "secondary"}
              onClick={() => setSource(item)}
            >
              {item === "all" ? <LayoutTemplate size={15} aria-hidden /> : sourceIcon(item)}
              {t(`gallery.source.${item}`)}
            </UiButton>
          ))}
        </div>
      </UiCard>

      {loading ? (
        <div className="gallery-state" role="status">{t("gallery.loading")}</div>
      ) : galleryQuery.isError && !galleryQuery.data ? (
        <div className="gallery-state" role="alert">
          <TriangleAlert size={34} aria-hidden />
          <strong>{t("gallery.loadFailed")}</strong>
          <UiButton onClick={() => void galleryQuery.refetch()}>{t("common.retry")}</UiButton>
        </div>
      ) : visibleTemplates.length === 0 ? (
        <div className="gallery-state">
          <LayoutTemplate size={34} aria-hidden />
          <strong>{t("gallery.emptyTitle")}</strong>
          <span>{t("gallery.emptyHint")}</span>
        </div>
      ) : (
        <div className="gallery-grid">
          {visibleTemplates.map((template) => (
            <TemplateCard
              key={`${template.source}:${template.id}`}
              template={template}
              locale={locale}
              t={t}
              busy={busyTemplateId === template.id}
              onUse={openUseDialog}
              onEdit={(item) => {
                if (item.project_id) navigate(`/project/${item.project_id}`);
              }}
              onRemove={setRemoveDialog}
            />
          ))}
        </div>
      )}

      <UiDialog
        open={!!useDialog}
        title={t("gallery.useDialogTitle")}
        description={
          useDialog
            ? t("gallery.useDialogHint", { name: localizedTemplateText(useDialog.name, locale) })
            : undefined
        }
        onClose={() => setUseDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setUseDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              disabled={!projectName.trim() || busyTemplateId === useDialog?.id}
              onClick={useTemplate}
            >
              {busyTemplateId === useDialog?.id ? t("gallery.creating") : t("gallery.createProject")}
            </UiButton>
          </>
        }
      >
        <UiInput
          label={t("projects.namePlaceholder")}
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </UiDialog>

      <UiDialog
        open={createPersonalOpen}
        title={t("gallery.createPersonalTitle")}
        description={t("gallery.createPersonalHint")}
        onClose={() => setCreatePersonalOpen(false)}
        actions={
          <>
            <UiButton onClick={() => setCreatePersonalOpen(false)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              disabled={!sourceProjectId || busyTemplateId === sourceProjectId}
              onClick={createPersonalTemplate}
            >
              {busyTemplateId === sourceProjectId ? t("gallery.saving") : t("gallery.addToGallery")}
            </UiButton>
          </>
        }
      >
        {eligibleProjects.length > 0 ? (
          <UiSelect
            label={t("gallery.sourceProject")}
            value={sourceProjectId}
            onChange={(event) => setSourceProjectId(event.target.value)}
          >
            {eligibleProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </UiSelect>
        ) : (
          <div className="gallery-dialog-empty">{t("gallery.noEligibleProjects")}</div>
        )}
      </UiDialog>

      <UiDialog
        open={!!removeDialog}
        title={t("gallery.removeTitle")}
        description={
          removeDialog
            ? t("gallery.removeHint", { name: localizedTemplateText(removeDialog.name, locale) })
            : undefined
        }
        onClose={() => setRemoveDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setRemoveDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="danger"
              disabled={busyTemplateId === removeDialog?.id}
              onClick={removePersonalTemplate}
            >
              {t("gallery.removeAction")}
            </UiButton>
          </>
        }
      />
      {(error || galleryQuery.error) && (
        <div className="error" role="alert">
          {error ||
            (galleryQuery.error instanceof Error
              ? galleryQuery.error.message
              : t("gallery.loadFailed"))}
        </div>
      )}
    </section>
  );
}
