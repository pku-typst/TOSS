import { useCallback, useEffect, useRef, useState } from "react";
import {
  getProjectAssetContentCached,
  type ProjectAsset
} from "@/lib/api";
import { sameAssetMetaMap } from "@/pages/workspace/equality";
import { createAssetHydrationProgressState } from "@/pages/workspace/state";
import { retainUnchangedAssetContents } from "@/pages/workspace/sync";
import type { AssetMeta } from "@/pages/workspace/types";

const EMPTY_ASSET_CONTENTS: Record<string, string> = {};

type UseWorkspaceAssetsInput = {
  projectId: string;
  effectiveUserId: string;
  sessionGeneration: string;
  assetMeta: Record<string, AssetMeta>;
};

export function useWorkspaceAssets({
  projectId,
  effectiveUserId,
  sessionGeneration,
  assetMeta,
}: UseWorkspaceAssetsInput) {
  const scopeKey = sessionGeneration;
  const [assetBase64, setAssetBase64] = useState<Record<string, string>>({});
  const [assetHydrationProgress, setAssetHydrationProgress] = useState(
    createAssetHydrationProgressState
  );
  const assetMetaRef = useRef<Record<string, AssetMeta>>({});
  const assetBase64Ref = useRef<Record<string, string>>({});
  const assetLoadInflightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const assetLoadFailedRef = useRef<Set<string>>(new Set());
  const scopeKeyRef = useRef(scopeKey);
  const publishedScopeKeyRef = useRef(scopeKey);
  const assetGenerationRef = useRef(0);
  scopeKeyRef.current = scopeKey;

  const toProjectAsset = useCallback(
    (path: string, meta: AssetMeta): ProjectAsset | null => {
      if (
        !projectId ||
        !meta.id ||
        !meta.contentRevision ||
        !meta.createdAt ||
        typeof meta.sizeBytes !== "number"
      ) {
        return null;
      }
      return {
        id: meta.id,
        project_id: projectId,
        path,
        content_revision: meta.contentRevision,
        content_type: meta.contentType || "application/octet-stream",
        size_bytes: meta.sizeBytes,
        uploaded_by: null,
        created_at: meta.createdAt
      };
    },
    [projectId]
  );

  const ensureLiveAssetLoaded = useCallback(
    async (path: string): Promise<string | null> => {
      if (!projectId) return null;
      const requestScope = scopeKey;
      const requestGeneration = assetGenerationRef.current;
      const existing = assetBase64Ref.current[path];
      if (existing) return existing;
      const loadKey = `${requestScope}\u0000${requestGeneration}\u0000${path}`;
      const inflight = assetLoadInflightRef.current.get(loadKey);
      if (inflight) return inflight;
      const meta = assetMetaRef.current[path];
      if (!meta) return null;
      const asset = toProjectAsset(path, meta);
      if (!asset) return null;
      const loadPromise = (async () => {
        try {
          const response = await getProjectAssetContentCached(
            effectiveUserId,
            projectId,
            asset
          );
          const contentBase64 = response.content_base64;
          if (
            scopeKeyRef.current !== requestScope ||
            assetGenerationRef.current !== requestGeneration
          ) {
            return contentBase64;
          }
          setAssetBase64((previous) => {
            if (previous[path] === contentBase64) return previous;
            const next = { ...previous, [path]: contentBase64 };
            publishedScopeKeyRef.current = requestScope;
            assetBase64Ref.current = next;
            return next;
          });
          assetLoadFailedRef.current.delete(path);
          return contentBase64;
        } catch {
          if (
            scopeKeyRef.current === requestScope &&
            assetGenerationRef.current === requestGeneration
          ) {
            assetLoadFailedRef.current.add(path);
          }
          return null;
        } finally {
          assetLoadInflightRef.current.delete(loadKey);
        }
      })();
      assetLoadInflightRef.current.set(loadKey, loadPromise);
      return loadPromise;
    },
    [effectiveUserId, projectId, scopeKey, toProjectAsset]
  );

  const hydrateProjectAssetsForInitialLoad = useCallback(
    async (
      documents: Record<string, string>,
      nextAssetMeta: Record<string, AssetMeta>
    ) => {
      if (!projectId) return;
      const hydrationScope = scopeKey;
      const hydrationGeneration = assetGenerationRef.current;
      const assetPaths = Object.keys(nextAssetMeta);
      const documentCount = Object.keys(documents).length;
      const documentBytes = Object.values(documents).reduce(
        (sum, content) => sum + content.length,
        0
      );
      const totalAssetBytes = assetPaths.reduce(
        (sum, path) => sum + Math.max(0, nextAssetMeta[path]?.sizeBytes || 0),
        0
      );
      const totalFiles = documentCount + assetPaths.length;
      const totalBytes = documentBytes + totalAssetBytes;
      let loadedFiles = documentCount;
      let loadedBytes = documentBytes;

      const publishProgress = () => {
        if (
          scopeKeyRef.current !== hydrationScope ||
          assetGenerationRef.current !== hydrationGeneration
        ) {
          return;
        }
        setAssetHydrationProgress({
          active: loadedFiles < totalFiles,
          loaded: loadedFiles,
          total: totalFiles,
          loadedBytes,
          totalBytes
        });
      };

      publishProgress();
      if (assetPaths.length === 0) return;

      const concurrency = Math.min(6, assetPaths.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < assetPaths.length) {
          const index = cursor;
          cursor += 1;
          const path = assetPaths[index];
          if (!path) continue;
          const loaded = await ensureLiveAssetLoaded(path);
          loadedFiles += 1;
          if (loaded) {
            loadedBytes += Math.max(0, nextAssetMeta[path]?.sizeBytes || 0);
          }
          publishProgress();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    },
    [ensureLiveAssetLoaded, projectId, scopeKey]
  );

  const reconcileAssetCatalog = useCallback((nextMeta: Record<string, AssetMeta>) => {
    const previousMeta = assetMetaRef.current;
    const unchanged = sameAssetMetaMap(previousMeta, nextMeta);
    const stableMeta = unchanged ? previousMeta : nextMeta;
    if (!unchanged) {
      assetGenerationRef.current += 1;
      assetLoadInflightRef.current.clear();
      assetLoadFailedRef.current.clear();
    }
    const previousContents = assetBase64Ref.current;
    const retainedContents = retainUnchangedAssetContents(
      previousContents,
      previousMeta,
      stableMeta
    );
    assetMetaRef.current = stableMeta;
    assetBase64Ref.current = retainedContents;
    publishedScopeKeyRef.current = scopeKey;
    assetLoadFailedRef.current.clear();
    setAssetBase64(retainedContents);
  }, [scopeKey]);

  const resetAssetLoading = useCallback(() => {
    assetGenerationRef.current += 1;
    assetLoadInflightRef.current.clear();
    assetLoadFailedRef.current.clear();
    setAssetHydrationProgress(createAssetHydrationProgressState());
  }, []);

  useEffect(() => {
    assetGenerationRef.current += 1;
    publishedScopeKeyRef.current = scopeKey;
    assetMetaRef.current = {};
    assetBase64Ref.current = {};
    assetLoadInflightRef.current.clear();
    assetLoadFailedRef.current.clear();
    setAssetBase64({});
    setAssetHydrationProgress(createAssetHydrationProgressState());
  }, [scopeKey]);

  useEffect(() => {
    reconcileAssetCatalog(assetMeta);
  }, [assetMeta, reconcileAssetCatalog, scopeKey]);

  return {
    assetBase64:
      publishedScopeKeyRef.current === scopeKey
        ? assetBase64
        : EMPTY_ASSET_CONTENTS,
    assetMeta,
    assetHydrationProgress,
    setAssetHydrationProgress,
    assetBase64Ref,
    assetLoadFailedRef,
    reconcileAssetCatalog,
    ensureLiveAssetLoaded,
    hydrateProjectAssetsForInitialLoad,
    resetAssetLoading
  };
}
