import type { Document, ProjectAsset } from "@/lib/api";
import type { AssetMeta, DocumentIdentity } from "@/pages/workspace/types";

export function mapDocumentsByPath(documents: Document[]) {
  const output: Record<string, string> = {};
  for (const doc of documents) {
    output[doc.path] = doc.content;
  }
  return output;
}

export function mapDocumentIdentitiesByPath(documents: Document[]) {
  const output: Record<string, DocumentIdentity> = {};
  for (const document of documents) {
    output[document.path] = {
      id: document.id,
      pathRevision: document.path_revision,
      collaborationRevision: document.collaboration_revision
    };
  }
  return output;
}

export function mapAssetMetaByPath(assets: ProjectAsset[]) {
  const output: Record<string, AssetMeta> = {};
  for (const asset of assets) {
    output[asset.path] = {
      id: asset.id,
      contentRevision: asset.content_revision,
      contentType: asset.content_type,
      sizeBytes: asset.size_bytes,
      createdAt: asset.created_at
    };
  }
  return output;
}
