import type { AssetMeta, ProjectNode } from "@/pages/workspace/types";

export function sameAssetMeta(a: AssetMeta | undefined, b: AssetMeta | undefined) {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.contentRevision === b.contentRevision &&
    a.contentType === b.contentType &&
    a.sizeBytes === b.sizeBytes &&
    a.createdAt === b.createdAt
  );
}

export function sameAssetMetaMap(a: Record<string, AssetMeta>, b: Record<string, AssetMeta>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!sameAssetMeta(a[key], b[key])) return false;
  }
  return true;
}

export function sameStringMap(a: Record<string, string>, b: Record<string, string>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function sameProjectNodeList(a: ProjectNode[], b: ProjectNode[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.path !== right.path || left.kind !== right.kind) return false;
  }
  return true;
}
