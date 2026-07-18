import type { BrowserProjectSeed } from "@/browserBackend/browserRecords";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";
import type { ProjectCatalog } from "@/projects/projectCatalog";

export class BrowserProjectCatalog implements ProjectCatalog {
  constructor(
    private readonly store: BrowserWorkspaceStore,
    private readonly projectSeeds: Record<"typst" | "latex", BrowserProjectSeed | null>,
  ) {}

  async list(query?: { includeArchived?: boolean; q?: string }) {
    return { projects: await this.store.listProjects(query) };
  }

  create(input: Parameters<ProjectCatalog["create"]>[0]) {
    const projectType = input.project_type ?? "typst";
    const seed = this.projectSeeds[projectType];
    if (!seed) throw new Error("project_type_disabled");
    return this.store.createProject(input, seed);
  }

  copy(projectId: string, input: Parameters<ProjectCatalog["copy"]>[1]) {
    return this.store.copyProject(projectId, input.name);
  }

  rename(projectId: string, name: string) {
    return this.store.renameProject(projectId, name);
  }

  setArchived(projectId: string, archived: boolean) {
    return this.store.setArchived(projectId, archived);
  }

  loadThumbnail(project: Parameters<ProjectCatalog["loadThumbnail"]>[0]) {
    return this.store.loadThumbnail(project.id);
  }

  saveThumbnail(
    projectId: string,
    input: Parameters<ProjectCatalog["saveThumbnail"]>[1],
  ) {
    return this.store.saveThumbnail(projectId, input);
  }
}
