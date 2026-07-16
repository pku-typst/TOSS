import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import type { AssetHydrationProgressState } from "@/pages/workspace/state";
import type { AssetMeta } from "@/pages/workspace/types";
import { isTextFile } from "@/pages/workspace/utils";

type UseWorkspaceAssetHydrationInput = {
  projectId: string;
  workspaceLoaded: boolean;
  workspaceSyncPending: boolean;
  revisionMode: boolean;
  activePath: string;
  assetBase64: Record<string, string>;
  assetMeta: Record<string, AssetMeta>;
  requiredAssetPaths: string[];
  assetBase64Ref: MutableRefObject<Record<string, string>>;
  failedAssetPathsRef: MutableRefObject<Set<string>>;
  setProgress: Dispatch<SetStateAction<AssetHydrationProgressState>>;
  synchronizeWorkspace: () => Promise<void>;
  ensureAssetLoaded: (path: string) => Promise<string | null>;
};

export function useWorkspaceAssetHydration({
  projectId,
  workspaceLoaded,
  workspaceSyncPending,
  revisionMode,
  activePath,
  assetBase64,
  assetMeta,
  requiredAssetPaths,
  assetBase64Ref,
  failedAssetPathsRef,
  setProgress,
  synchronizeWorkspace,
  ensureAssetLoaded
}: UseWorkspaceAssetHydrationInput) {
  useEffect(() => {
    if (!projectId || !workspaceLoaded || revisionMode || !activePath) return;
    if (isTextFile(activePath) || assetBase64Ref.current[activePath]) return;
    let cancelled = false;
    const loadActiveAsset = async () => {
      await synchronizeWorkspace();
      if (cancelled || assetBase64Ref.current[activePath]) return;
      await ensureAssetLoaded(activePath);
    };
    void loadActiveAsset();
    return () => {
      cancelled = true;
    };
  }, [
    activePath,
    assetBase64Ref,
    ensureAssetLoaded,
    projectId,
    revisionMode,
    synchronizeWorkspace,
    workspaceLoaded
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || revisionMode || workspaceSyncPending) return;
    const total = requiredAssetPaths.length;
    const loaded = requiredAssetPaths.filter((path) => !!assetBase64[path]).length;
    const totalBytes = requiredAssetPaths.reduce(
      (sum, path) => sum + Math.max(0, assetMeta[path]?.sizeBytes || 0),
      0
    );
    const loadedBytes = requiredAssetPaths.reduce(
      (sum, path) =>
        sum + (assetBase64[path] ? Math.max(0, assetMeta[path]?.sizeBytes || 0) : 0),
      0
    );
    const missing = requiredAssetPaths.filter(
      (path) => !assetBase64[path] && !failedAssetPathsRef.current.has(path)
    );
    setProgress({
      active: missing.length > 0,
      loaded,
      total,
      loadedBytes,
      totalBytes
    });
    if (missing.length === 0) return;
    let cancelled = false;
    const hydrateRequiredAssets = async () => {
      for (const path of missing) {
        if (cancelled) return;
        await ensureAssetLoaded(path);
      }
    };
    void hydrateRequiredAssets();
    return () => {
      cancelled = true;
    };
  }, [
    assetBase64,
    assetMeta,
    ensureAssetLoaded,
    failedAssetPathsRef,
    projectId,
    requiredAssetPaths,
    revisionMode,
    setProgress,
    workspaceLoaded,
    workspaceSyncPending
  ]);
}
