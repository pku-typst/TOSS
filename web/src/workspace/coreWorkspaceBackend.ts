import {
  createProjectFile,
  deleteProjectFile,
  downloadProjectArchive,
  getProjectAssetContentCached,
  moveProjectFile,
  updateProjectEntryFile,
  updateProjectLatexEngine,
  uploadProjectAsset,
  upsertDocumentByPath,
} from "@/lib/api";
import { base64ToBytes } from "@/lib/base64";
import {
  loadWorkspaceBootstrap,
  loadWorkspaceDelta,
} from "@/pages/workspace/loaders";
import type { WorkspaceBackend } from "@/workspace/workspaceBackend";

export const coreWorkspaceBackend: WorkspaceBackend = {
  loadBootstrap: loadWorkspaceBootstrap,
  loadDelta: loadWorkspaceDelta,
  createFile: createProjectFile,
  movePath(projectId, input) {
    return moveProjectFile(projectId, input.from_path, input.to_path);
  },
  deletePath: deleteProjectFile,
  upsertText: upsertDocumentByPath,
  uploadAsset: uploadProjectAsset,
  async readAsset(cacheIdentity, projectId, asset) {
    const response = await getProjectAssetContentCached(
      cacheIdentity,
      projectId,
      asset,
    );
    return base64ToBytes(response.content_base64);
  },
  updateEntryFile: updateProjectEntryFile,
  updateLatexEngine: updateProjectLatexEngine,
  async downloadArchive(projectId) {
    return {
      blob: await downloadProjectArchive(projectId),
      extension: "zip",
    };
  },
};
