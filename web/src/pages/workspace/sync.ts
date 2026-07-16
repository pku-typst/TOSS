import { sameAssetMeta, sameStringMap } from "@/pages/workspace/equality";
import type { AssetMeta, ProjectNode } from "@/pages/workspace/types";
import { isTextFile } from "@/pages/workspace/utils";

type MergeWorkspaceDocumentsInput = {
  current: Record<string, string>;
  incoming: Record<string, string>;
  nodes: ProjectNode[];
  activePath: string;
  activeDocumentDirty: boolean;
  activeDocumentText: string;
};

export function mergeWorkspaceDocumentDelta(
  input: MergeWorkspaceDocumentsInput
): Record<string, string> {
  const textFilePaths = new Set(
    input.nodes
      .filter((node) => node.kind === "file" && isTextFile(node.path))
      .map((node) => node.path)
  );
  const next = { ...input.current };

  for (const [path, content] of Object.entries(input.incoming)) {
    if (!isTextFile(path)) continue;
    if (path === input.activePath && input.activeDocumentDirty) continue;
    next[path] = content;
  }
  for (const path of Object.keys(next)) {
    if (textFilePaths.has(path)) continue;
    if (path === input.activePath && input.activeDocumentDirty) {
      next[path] = input.activeDocumentText;
      continue;
    }
    delete next[path];
  }

  return sameStringMap(input.current, next) ? input.current : next;
}

export function retainUnchangedAssetContents(
  currentContents: Record<string, string>,
  currentMeta: Record<string, AssetMeta>,
  nextMeta: Record<string, AssetMeta>
): Record<string, string> {
  const nextContents: Record<string, string> = {};
  for (const [path, content] of Object.entries(currentContents)) {
    if (sameAssetMeta(currentMeta[path], nextMeta[path])) {
      nextContents[path] = content;
    }
  }
  return sameStringMap(currentContents, nextContents) ? currentContents : nextContents;
}
