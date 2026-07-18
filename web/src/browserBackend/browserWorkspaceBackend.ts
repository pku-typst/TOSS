import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";
import type { WorkspaceBackend } from "@/workspace/workspaceBackend";

export function createBrowserWorkspaceBackend(
  store: BrowserWorkspaceStore,
): WorkspaceBackend {
  return {
    loadBootstrap: (input) => store.loadBootstrap(input),
    loadDelta: (input) => store.loadDelta(input),
    createFile: (projectId, input) => store.createFile(projectId, input),
    movePath: (projectId, input) => store.movePath(projectId, input),
    deletePath: (projectId, path) => store.deletePath(projectId, path),
    upsertText: (projectId, path, content, contentEpoch) =>
      store.upsertText(projectId, path, content, contentEpoch),
    uploadAsset: (projectId, input) => store.uploadAsset(projectId, input),
    readAsset: (_cacheIdentity, projectId, asset) =>
      store.readAsset(projectId, asset.id),
    updateEntryFile: (projectId, input) =>
      store.updateEntryFile(projectId, input),
    updateLatexEngine: (projectId, input) =>
      store.updateLatexEngine(projectId, input),
    async downloadArchive(projectId) {
      return {
        blob: await store.downloadArchive(projectId),
        extension: "tar.gz",
      };
    },
  };
}
