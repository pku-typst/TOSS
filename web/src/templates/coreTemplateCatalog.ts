import {
  builtinTemplateThumbnailUrl,
  copyProject,
  createProjectFromBuiltinTemplate,
  listTemplateGallery,
  projectThumbnailUrl,
  updateProjectTemplate,
} from "@/lib/api";
import type { TemplateCatalog } from "@/templates/templateCatalog";

export const coreTemplateCatalog: TemplateCatalog = {
  list: listTemplateGallery,
  async instantiate(template, name) {
    if (template.source === "builtin") {
      return createProjectFromBuiltinTemplate(template.id, { name });
    }
    if (!template.project_id) throw new Error("template_project_missing");
    return copyProject(template.project_id, { name });
  },
  async setProjectTemplate(projectId, enabled) {
    await updateProjectTemplate(projectId, enabled);
  },
  async loadThumbnail(template) {
    if (!template.has_thumbnail) return null;
    const url =
      template.source === "builtin"
        ? builtinTemplateThumbnailUrl(template.id)
        : projectThumbnailUrl(
            template.project_id ?? template.id,
            template.updated_at ?? undefined,
          );
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include",
    });
    return response.ok ? response.blob() : null;
  },
};
