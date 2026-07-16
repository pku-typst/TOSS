import type { RevisionTransfer } from "@/lib/api";
import type { AssetMeta, ProjectNode } from "@/pages/workspace/types";

type RevisionTransferInput = {
  response: RevisionTransfer;
  forceFull?: boolean;
  currentRevisionAnchorId: string | null;
  liveDocs: Record<string, string>;
  liveAssets: Record<string, string>;
  liveAssetMeta: Record<string, AssetMeta>;
  revisionDocs: Record<string, string>;
  revisionAssets: Record<string, string>;
  revisionAssetMeta: Record<string, AssetMeta>;
};

type RevisionTransferResult = {
  applied: boolean;
  docs: Record<string, string>;
  nodes: ProjectNode[];
  assets: Record<string, string>;
  assetMeta: Record<string, AssetMeta>;
  entryFilePath: string;
};

export function applyRevisionTransfer(input: RevisionTransferInput): RevisionTransferResult {
  const transferMode =
    !input.forceFull && input.response.transfer_mode === "delta" ? "delta" : "full";
  const baseAnchor = input.response.base_anchor ?? "none";
  const baseRevisionId = input.response.base_revision_id ?? null;

  let docs: Record<string, string> = {};
  let assets: Record<string, string> = {};
  let assetMeta: Record<string, AssetMeta> = {};

  if (transferMode === "delta") {
    if (
      baseAnchor === "revision" &&
      baseRevisionId &&
      input.currentRevisionAnchorId &&
      baseRevisionId === input.currentRevisionAnchorId
    ) {
      docs = { ...input.revisionDocs };
      assets = { ...input.revisionAssets };
      assetMeta = { ...input.revisionAssetMeta };
    } else if (baseAnchor === "live") {
      docs = { ...input.liveDocs };
      assets = { ...input.liveAssets };
      assetMeta = { ...input.liveAssetMeta };
    } else if (baseAnchor === "none") {
      docs = {};
      assets = {};
      assetMeta = {};
    } else {
      const fallbackEntryFromNodes =
        (input.response.nodes || []).find((node) => node.kind === "file" && /\.(tex|ltx)$/i.test(node.path))?.path ||
        (input.response.nodes || []).find((node) => node.kind === "file" && /\.typ$/i.test(node.path))?.path ||
        "main.typ";
      return {
        applied: false,
        docs: {},
        nodes: [],
        assets: {},
        assetMeta: {},
        entryFilePath: fallbackEntryFromNodes
      };
    }
  }

  for (const path of input.response.deleted_documents || []) {
    delete docs[path];
  }
  for (const doc of input.response.documents || []) {
    docs[doc.path] = doc.content;
  }

  for (const path of input.response.deleted_assets || []) {
    delete assets[path];
    delete assetMeta[path];
  }
  for (const asset of input.response.assets || []) {
    assets[asset.path] = asset.content_base64;
    assetMeta[asset.path] = {
      contentType: asset.content_type
    };
  }

  const fallbackEntryFromNodes =
    (input.response.nodes || []).find((node) => node.kind === "file" && /\.(tex|ltx)$/i.test(node.path))?.path ||
    (input.response.nodes || []).find((node) => node.kind === "file" && /\.typ$/i.test(node.path))?.path ||
    "main.typ";
  return {
    applied: true,
    docs,
    nodes: (input.response.nodes || []) as ProjectNode[],
    assets,
    assetMeta,
    entryFilePath: input.response.entry_file_path || fallbackEntryFromNodes
  };
}
