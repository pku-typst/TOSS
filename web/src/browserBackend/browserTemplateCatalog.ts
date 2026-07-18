import type { BrowserTemplateDefinition } from "@/browserBackend/browserRecords";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";
import type { TemplateGalleryItem } from "@/lib/api/types";
import type { TemplateCatalog } from "@/templates/templateCatalog";

export class BrowserTemplateCatalog implements TemplateCatalog {
  private readonly definitions: Map<string, BrowserTemplateDefinition>;

  constructor(
    private readonly store: BrowserWorkspaceStore,
    definitions: BrowserTemplateDefinition[],
  ) {
    this.definitions = new Map(
      definitions.map((definition) => [definition.item.id, definition]),
    );
  }

  async list() {
    const projects = await this.store.listProjects({ includeArchived: false });
    const personal: TemplateGalleryItem[] = projects
      .filter((project) => project.is_template)
      .map((project) => ({
        id: project.id,
        source: "personal",
        project_id: project.id,
        name: { en: project.name, "zh-CN": project.name },
        description: { en: "", "zh-CN": "" },
        category: project.project_type === "latex" ? "article" : "document",
        tags: [],
        project_type: project.project_type,
        owner_display_name: null,
        featured: false,
        can_edit: true,
        can_read: true,
        has_thumbnail: project.has_thumbnail,
        updated_at: project.last_edited_at,
        accent_color: "#2563eb",
      }));
    return {
      templates: [
        ...[...this.definitions.values()].map((definition) => definition.item),
        ...personal,
      ],
    };
  }

  async instantiate(template: TemplateGalleryItem, name: string) {
    if (template.source !== "builtin") {
      if (!template.project_id) throw new Error("template_project_missing");
      return this.store.copyProject(template.project_id, name);
    }
    const definition = this.definitions.get(template.id);
    if (!definition) throw new Error("template_not_found");
    return this.store.createSeededProject(name, {
      projectType: definition.item.project_type,
      latexEngine: definition.latexEngine,
      entryFilePath: definition.entryFilePath,
      files: definition.files,
    });
  }

  setProjectTemplate(projectId: string, enabled: boolean) {
    return this.store.setTemplate(projectId, enabled);
  }

  async loadThumbnail(template: TemplateGalleryItem) {
    if (template.source !== "builtin") {
      return template.project_id
        ? this.store.loadThumbnail(template.project_id)
        : null;
    }
    const thumbnail = this.definitions.get(template.id)?.thumbnail;
    if (!thumbnail) return null;
    const binary = atob(thumbnail.contentBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: thumbnail.contentType });
  }
}
