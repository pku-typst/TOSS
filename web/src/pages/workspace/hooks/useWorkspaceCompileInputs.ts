import { useMemo, useState } from "react";
import type { LatexEngine } from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import {
  CompileWorldProjector,
  createCompileTarget,
} from "@/pages/workspace/compileWorld";
import type { AssetMeta } from "@/pages/workspace/types";
import { collectReferencedAssetPaths } from "@/pages/workspace/utils";

type UseWorkspaceCompileInputsInput = {
  projectId: string;
  activeRevisionId: string | null;
  isRevisionMode: boolean;
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  documents: Record<string, string>;
  assetBase64: Record<string, string>;
  liveAssetMeta: Record<string, AssetMeta>;
  activePath: string;
  activeDocumentText: string;
  hasActiveLiveDocument: boolean;
  realtimeDocumentReady: boolean;
  realtimeBoundPath: string;
  typstPreviewRenderer: "canvas" | "pdf";
};

export function useWorkspaceCompileInputs({
  projectId,
  activeRevisionId,
  isRevisionMode,
  projectType,
  latexEngine,
  entryFilePath,
  documents,
  assetBase64,
  liveAssetMeta,
  activePath,
  activeDocumentText,
  hasActiveLiveDocument,
  realtimeDocumentReady,
  realtimeBoundPath,
  typstPreviewRenderer
}: UseWorkspaceCompileInputsInput) {
  const activeLiveDocumentReady =
    !isRevisionMode &&
    hasActiveLiveDocument &&
    realtimeDocumentReady &&
    realtimeBoundPath === activePath;
  const scope = `${projectId}:${
    isRevisionMode ? `revision:${activeRevisionId}` : "live"
  }`;
  const [projector] = useState(() => new CompileWorldProjector());
  const world = useMemo(
    () =>
      projector.project({
        scope,
        projectType,
        entryFilePath,
        documents,
        assets: assetBase64,
        activeDocument:
          activeLiveDocumentReady && activePath
            ? { path: activePath, content: activeDocumentText }
            : undefined,
      }),
    [
      activeDocumentText,
      activeLiveDocumentReady,
      activePath,
      assetBase64,
      documents,
      entryFilePath,
      projector,
      projectType,
      scope,
    ],
  );
  const target = useMemo(
    () =>
      createCompileTarget(
        projectType,
        latexEngine,
        typstPreviewRenderer === "pdf",
      ),
    [latexEngine, projectType, typstPreviewRenderer],
  );

  const requiredAssetPaths = useMemo(() => {
    if (isRevisionMode) return [];
    if (projectType === "latex") return Object.keys(liveAssetMeta);
    return collectReferencedAssetPaths(world.documents, liveAssetMeta);
  }, [
    isRevisionMode,
    liveAssetMeta,
    projectType,
    world.documents,
  ]);

  return {
    world,
    target,
    requiredAssetPaths,
    activeLiveDocumentReady,
  };
}
