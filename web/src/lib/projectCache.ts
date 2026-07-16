type CachedNode = { path: string; kind: "file" | "directory" };

export type CachedProjectSnapshot = {
  cacheIdentity: string;
  projectId: string;
  entryFilePath: string;
  nodes: CachedNode[];
  docs: Record<string, string>;
  cachedAt: number;
};

type LoadProjectSnapshotOptions = {
  minCachedAtMs?: number;
};

const CACHE_PREFIX = "toss.project.cache.v2.";
const LEGACY_CACHE_PREFIX = "typst.project.cache.";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROJECT_CACHE_COUNT = 20;
const MAX_SNAPSHOT_BYTES = 2_000_000;

function cacheKey(cacheIdentity: string, projectId: string) {
  return `${CACHE_PREFIX}${encodeURIComponent(cacheIdentity)}.${encodeURIComponent(projectId)}`;
}

function allCacheKeys() {
  if (typeof window === "undefined") return [] as string[];
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) out.push(key);
  }
  return out;
}

function pruneCaches() {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const entries: Array<{ key: string; cachedAt: number }> = [];
  for (const key of allCacheKeys()) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as CachedProjectSnapshot;
      if (!parsed.cachedAt || now - parsed.cachedAt > CACHE_TTL_MS) {
        window.localStorage.removeItem(key);
        continue;
      }
      entries.push({ key, cachedAt: parsed.cachedAt });
    } catch {
      window.localStorage.removeItem(key);
    }
  }
  entries.sort((a, b) => b.cachedAt - a.cachedAt);
  for (let i = MAX_PROJECT_CACHE_COUNT; i < entries.length; i += 1) {
    window.localStorage.removeItem(entries[i].key);
  }
}

function removeLegacyCaches() {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(LEGACY_CACHE_PREFIX)) keys.push(key);
  }
  for (const key of keys) window.localStorage.removeItem(key);
}

export function clearProjectSnapshotCaches() {
  if (typeof window === "undefined") return;
  const keys = allCacheKeys();
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(LEGACY_CACHE_PREFIX)) keys.push(key);
  }
  for (const key of new Set(keys)) window.localStorage.removeItem(key);
}

export function loadProjectSnapshotFromCache(
  cacheIdentity: string,
  projectId: string,
  options?: LoadProjectSnapshotOptions
): CachedProjectSnapshot | null {
  if (typeof window === "undefined") return null;
  removeLegacyCaches();
  if (!cacheIdentity || !projectId) return null;
  const key = cacheKey(cacheIdentity, projectId);
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedProjectSnapshot;
    if (
      parsed.cacheIdentity !== cacheIdentity ||
      parsed.projectId !== projectId ||
      !parsed.cachedAt ||
      Date.now() - parsed.cachedAt > CACHE_TTL_MS
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    if (
      typeof options?.minCachedAtMs === "number" &&
      Number.isFinite(options.minCachedAtMs) &&
      parsed.cachedAt < options.minCachedAtMs
    ) {
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

export function saveProjectSnapshotToCache(input: {
  cacheIdentity: string;
  projectId: string;
  entryFilePath: string;
  nodes: CachedNode[];
  docs: Record<string, string>;
}) {
  if (typeof window === "undefined") return;
  removeLegacyCaches();
  if (!input.cacheIdentity || !input.projectId) return;
  const snapshot: CachedProjectSnapshot = {
    cacheIdentity: input.cacheIdentity,
    projectId: input.projectId,
    entryFilePath: input.entryFilePath,
    nodes: input.nodes,
    docs: input.docs,
    cachedAt: Date.now()
  };
  const serialized = JSON.stringify(snapshot);
  if (serialized.length > MAX_SNAPSHOT_BYTES) {
    // Avoid serving indefinitely stale cache when project snapshot outgrows limit.
    window.localStorage.removeItem(cacheKey(input.cacheIdentity, input.projectId));
    return;
  }
  try {
    window.localStorage.setItem(cacheKey(input.cacheIdentity, input.projectId), serialized);
    pruneCaches();
  } catch {
    // ignore quota errors and continue with normal online workflow
  }
}
