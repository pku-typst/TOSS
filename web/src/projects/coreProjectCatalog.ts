import {
  copyProject,
  createProject,
  listProjects,
  projectThumbnailUrl,
  renameProject,
  setProjectArchived,
  uploadProjectThumbnail,
} from "@/lib/api";
import type { ProjectCatalog } from "@/projects/projectCatalog";

export const coreProjectCatalog: ProjectCatalog = {
  list: listProjects,
  create: createProject,
  copy: copyProject,
  rename: renameProject,
  setArchived: setProjectArchived,
  async loadThumbnail(project) {
    if (!project.has_thumbnail) return null;
    const response = await fetch(
      projectThumbnailUrl(project.id, project.last_edited_at),
      {
        cache: "no-store",
        credentials: "include",
      },
    );
    return response.ok ? response.blob() : null;
  },
  saveThumbnail: uploadProjectThumbnail,
};
