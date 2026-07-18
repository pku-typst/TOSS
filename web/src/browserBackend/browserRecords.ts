import type {
  LatexEngine,
  Project,
  ProjectAsset,
  ProjectType,
  TemplateGalleryItem,
} from "@/lib/api/types";

export type BrowserTemplateFile =
  | { path: string; content: string; contentType?: string }
  | { path: string; contentBase64: string; contentType: string };

export type BrowserTemplateDefinition = {
  item: TemplateGalleryItem;
  entryFilePath: string;
  latexEngine: LatexEngine | null;
  files: BrowserTemplateFile[];
  thumbnail?: { contentBase64: string; contentType: string };
};

export type BrowserProjectSeed = {
  projectType: ProjectType;
  latexEngine: LatexEngine | null;
  entryFilePath: string;
  files: BrowserTemplateFile[];
};

export type StoredBrowserProject = {
  id: string;
  name: string;
  projectType: ProjectType;
  latexEngine: LatexEngine | null;
  entryFilePath: string;
  settingsRevision: number;
  contentEpoch: number;
  documentsChangeSequence: number;
  directories: string[];
  archived: boolean;
  archivedAt: string | null;
  isTemplate: boolean;
  hasThumbnail: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoredBrowserDocument = {
  id: string;
  projectId: string;
  path: string;
  content: string;
  yUpdate: ArrayBuffer;
  pathRevision: number;
  collaborationRevision: number;
  changeSequence: number;
  updatedAt: string;
};

export type StoredBrowserAsset = ProjectAsset & {
  bytes: ArrayBuffer;
};

export type StoredBrowserThumbnail = {
  projectId: string;
  contentType: string;
  bytes: ArrayBuffer;
};

export function toProject(record: StoredBrowserProject): Project {
  return {
    archived: record.archived,
    archived_at: record.archivedAt,
    can_read: true,
    created_at: record.createdAt,
    has_thumbnail: record.hasThumbnail,
    id: record.id,
    is_template: record.isTemplate,
    last_edited_at: record.updatedAt,
    latex_engine: record.latexEngine,
    my_role: "Owner",
    name: record.name,
    owner_display_name: "—",
    owner_user_id: null,
    project_type: record.projectType,
  };
}
