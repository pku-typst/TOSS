import { useRuntimeTemplateCatalog } from "@/composition/applicationRuntime";
import type {
  Project,
  TemplateGalleryItem,
  TemplateGalleryResponse,
} from "@/lib/api/types";

export interface TemplateCatalog {
  list(): Promise<TemplateGalleryResponse>;
  instantiate(template: TemplateGalleryItem, name: string): Promise<Project>;
  setProjectTemplate(projectId: string, enabled: boolean): Promise<void>;
  loadThumbnail(template: TemplateGalleryItem): Promise<Blob | null>;
}

export function useTemplateCatalog(): TemplateCatalog {
  return useRuntimeTemplateCatalog();
}
