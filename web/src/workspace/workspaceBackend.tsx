import { useRuntimeWorkspaceBackend } from "@/composition/applicationRuntime";
import type {
  CreateProjectFileInput,
  Document,
  MoveProjectFileInput,
  ProjectAsset,
  ProjectSettings,
  UpdateProjectEntryFileInput,
  UpdateProjectLatexEngineInput,
  UploadAssetInput,
} from "@/lib/api/types";
import type {
  LoadWorkspaceBootstrapInput,
  LoadWorkspaceDeltaInput,
  WorkspaceBootstrap,
  WorkspaceDelta,
} from "@/workspace/workspaceSnapshot";

export interface WorkspaceBackend {
  loadBootstrap(input: LoadWorkspaceBootstrapInput): Promise<WorkspaceBootstrap>;
  loadDelta(input: LoadWorkspaceDeltaInput): Promise<WorkspaceDelta>;
  createFile(projectId: string, input: CreateProjectFileInput): Promise<void>;
  movePath(projectId: string, input: MoveProjectFileInput): Promise<void>;
  deletePath(projectId: string, path: string): Promise<void>;
  upsertText(
    projectId: string,
    path: string,
    content: string,
    contentEpoch?: number,
  ): Promise<Document>;
  uploadAsset(projectId: string, input: UploadAssetInput): Promise<ProjectAsset>;
  readAsset(
    cacheIdentity: string,
    projectId: string,
    asset: ProjectAsset,
  ): Promise<Uint8Array>;
  updateEntryFile(
    projectId: string,
    input: UpdateProjectEntryFileInput,
  ): Promise<ProjectSettings>;
  updateLatexEngine(
    projectId: string,
    input: UpdateProjectLatexEngineInput,
  ): Promise<ProjectSettings>;
  downloadArchive(projectId: string): Promise<{
    blob: Blob;
    extension: "zip" | "tar.gz";
  }>;
}

export function useWorkspaceBackend(): WorkspaceBackend {
  return useRuntimeWorkspaceBackend();
}
