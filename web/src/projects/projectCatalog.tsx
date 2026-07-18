import { useRuntimeProjectCatalog } from "@/composition/applicationRuntime";
import type {
  CreateProjectCopyInput,
  CreateProjectInput,
  Project,
  ProjectListResponse,
  UploadProjectThumbnailInput,
} from "@/lib/api/types";

export type ProjectListQuery = {
  includeArchived?: boolean;
  q?: string;
};

export interface ProjectCatalog {
  list(query?: ProjectListQuery): Promise<ProjectListResponse>;
  create(input: CreateProjectInput): Promise<Project>;
  copy(projectId: string, input: CreateProjectCopyInput): Promise<Project>;
  rename(projectId: string, name: string): Promise<void>;
  setArchived(projectId: string, archived: boolean): Promise<void>;
  loadThumbnail(project: Project): Promise<Blob | null>;
  saveThumbnail(
    projectId: string,
    input: UploadProjectThumbnailInput,
  ): Promise<void>;
}

export function useProjectCatalog(): ProjectCatalog {
  return useRuntimeProjectCatalog();
}
