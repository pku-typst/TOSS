import {
  apiUrl,
  authCredentials,
  authHeaders,
  encodePathPreservingSlashes,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import { bytesToBase64 } from "@/lib/base64";
import type {
  CreateRevisionInput,
  CreateProjectFileInput,
  Document,
  DocumentsResponse,
  GitRepoLink,
  MoveProjectFileInput,
  ProjectAsset,
  ProjectAssetContentResponse,
  ProjectAssetListResponse,
  ProjectSettings,
  ProjectTreeResponse,
  Revision,
  RevisionTransfer,
  RevisionsResponse,
  TemplateStatus,
  UpdateDocumentInput,
  UpdateProjectTemplateInput,
  UploadAssetInput,
  UpdateProjectEntryFileInput,
  UpdateProjectLatexEngineInput,
  UpsertDocumentByPathInput,
} from "@/lib/api/types";

type DownloadProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type RevisionDocumentsFetchOptions = {
  currentRevisionId?: string | null;
  includeLiveAnchor?: boolean;
};

type ListRevisionsOptions = {
  before?: string;
  limit?: number;
};

export async function getProjectTree(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/tree`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectTreeResponse>(response, "api.loadProjectTree");
}

export async function createProjectFile(
  projectId: string,
  input: CreateProjectFileInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/files`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.createPath");
}

export async function moveProjectFile(
  projectId: string,
  fromPath: string,
  toPath: string
) {
  const input: MoveProjectFileInput = { from_path: fromPath, to_path: toPath };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/files/move`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.movePath");
}

export async function deleteProjectFile(projectId: string, path: string) {
  const safePath = encodePathPreservingSlashes(path);
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/files/${safePath}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "api.deletePath");
}

export async function listDocuments(
  projectId: string,
  options?: { path?: string; afterChangeSequence?: number | null }
) {
  const params = new URLSearchParams();
  if (options?.path) params.set("path", options.path);
  if (typeof options?.afterChangeSequence === "number") {
    params.set("after_change_sequence", String(options.afterChangeSequence));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/documents${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<DocumentsResponse>(response, "api.listDocuments");
}

export async function upsertDocumentByPath(
  projectId: string,
  path: string,
  content: string,
  contentEpoch?: number
) {
  const input: UpsertDocumentByPathInput = { content };
  const safePath = encodeURIComponent(path);
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/documents/by-path/${safePath}`),
    {
      method: "PUT",
      credentials: authCredentials(),
      headers: authHeaders({
        "content-type": "application/json",
        ...(typeof contentEpoch === "number"
          ? { "x-project-content-epoch": String(contentEpoch) }
          : {})
      }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<Document>(response, "api.saveDocument");
}

export async function updateDocument(
  projectId: string,
  documentId: string,
  content: string,
  expectedPathRevision: number,
  expectedCollaborationRevision: number,
  contentEpoch: number
) {
  const input: UpdateDocumentInput = {
    content,
    expected_path_revision: expectedPathRevision,
    expected_collaboration_revision: expectedCollaborationRevision
  };
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/documents/${documentId}`),
    {
      method: "PUT",
      credentials: authCredentials(),
      headers: authHeaders({
        "content-type": "application/json",
        "x-project-content-epoch": String(contentEpoch)
      }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<Document>(response, "api.saveDocument");
}

export async function listRevisions(projectId: string, options?: ListRevisionsOptions) {
  const params = new URLSearchParams();
  if (options?.before) params.set("before", options.before);
  if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
    params.set("limit", String(Math.floor(options.limit)));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/revisions${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<RevisionsResponse>(response, "api.listRevisions");
}

export async function createRevision(projectId: string, summary: string) {
  const input: CreateRevisionInput = { summary };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/revisions`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Revision>(response, "api.createRevision");
}

export async function getRevisionDocuments(
  projectId: string,
  revisionId: string,
  options?: RevisionDocumentsFetchOptions,
  onProgress?: (progress: DownloadProgress) => void
) {
  const params = new URLSearchParams();
  if (options?.currentRevisionId) params.set("current_revision_id", options.currentRevisionId);
  if (typeof options?.includeLiveAnchor === "boolean") {
    params.set("include_live_anchor", options.includeLiveAnchor ? "true" : "false");
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/revisions/${revisionId}/documents${query}`),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  if (!response.ok) await throwApiError(response, "api.loadRevisionDocuments");
  const totalHeader = Number.parseInt(response.headers.get("content-length") || "", 10);
  const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  if (!response.body) {
    const payload = (await response.json()) as RevisionTransfer;
    onProgress?.({ loadedBytes: totalBytes ?? 1, totalBytes });
    return payload;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  onProgress?.({ loadedBytes: 0, totalBytes });
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    loadedBytes += next.value.byteLength;
    chunks.push(next.value);
    onProgress?.({ loadedBytes, totalBytes });
  }
  const fullBytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    fullBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const jsonText = new TextDecoder().decode(fullBytes);
  return JSON.parse(jsonText) as RevisionTransfer;
}

export async function listProjectAssets(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/assets`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectAssetListResponse>(response, "api.listAssets");
}

const PROJECT_ASSET_CONTENT_CACHE_PREFIX = "toss.project.asset.content.v2.";

function projectAssetContentCacheName(cacheIdentity: string) {
  return `${PROJECT_ASSET_CONTENT_CACHE_PREFIX}${encodeURIComponent(cacheIdentity)}`;
}

export async function clearProjectAssetContentCaches() {
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(PROJECT_ASSET_CONTENT_CACHE_PREFIX))
      .map((name) => caches.delete(name))
  );
}

function assetContentVersionKey(asset: ProjectAsset) {
  return `${asset.id}:${asset.content_revision}`;
}

function projectAssetRawUrl(projectId: string, asset: ProjectAsset) {
  const params = new URLSearchParams({ v: assetContentVersionKey(asset) });
  return apiUrl(`/v1/projects/${projectId}/assets/${asset.id}/raw?${params.toString()}`);
}

async function getCachedAssetBytes(cacheIdentity: string, url: string): Promise<Uint8Array | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(projectAssetContentCacheName(cacheIdentity));
    const cached = await cache.match(url);
    if (!cached) return null;
    return new Uint8Array(await cached.arrayBuffer());
  } catch {
    return null;
  }
}

async function putCachedAssetBytes(
  cacheIdentity: string,
  url: string,
  bytes: Uint8Array,
  contentType: string
) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(projectAssetContentCacheName(cacheIdentity));
    const body = new Blob([new Uint8Array(bytes).buffer], {
      type: contentType || "application/octet-stream"
    });
    await cache.put(
      url,
      new Response(body, {
        headers: {
          "content-type": contentType || "application/octet-stream",
          "cache-control": "private, max-age=31536000, immutable"
        }
      })
    );
  } catch {
    // Cache storage is best-effort.
  }
}

export async function getProjectAssetContentCached(
  cacheIdentity: string,
  projectId: string,
  asset: ProjectAsset
) {
  const url = projectAssetRawUrl(projectId, asset);
  const cachedBytes = await getCachedAssetBytes(cacheIdentity, url);
  if (cachedBytes) {
    return {
      asset,
      content_base64: bytesToBase64(cachedBytes)
    } satisfies ProjectAssetContentResponse;
  }
  const response = await fetch(url, {
    credentials: authCredentials(),
    headers: authHeaders(),
    cache: "no-store"
  });
  if (!response.ok) await throwApiError(response, "api.loadAsset");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await putCachedAssetBytes(cacheIdentity, url, bytes, asset.content_type);
  return {
    asset,
    content_base64: bytesToBase64(bytes)
  } satisfies ProjectAssetContentResponse;
}

export async function uploadProjectAsset(
  projectId: string,
  input: UploadAssetInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/assets`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ProjectAsset>(response, "api.uploadAsset");
}

export async function getGitRepoLink(projectId: string) {
  const response = await fetch(apiUrl(`/v1/git/repo-link/${projectId}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<GitRepoLink>(response, "api.getGitRepo");
}

export async function getProjectSettings(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/settings`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectSettings>(response, "api.loadProjectSettings");
}

export async function updateProjectEntryFile(
  projectId: string,
  input: UpdateProjectEntryFileInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/settings/entry-file`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ProjectSettings>(response, "api.saveProjectSettings");
}

export async function updateProjectLatexEngine(
  projectId: string,
  input: UpdateProjectLatexEngineInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/settings/latex-engine`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ProjectSettings>(response, "api.saveProjectSettings");
}

export async function updateProjectTemplate(projectId: string, isTemplate: boolean) {
  const input: UpdateProjectTemplateInput = { is_template: isTemplate };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/template`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<TemplateStatus>(response, "api.updateTemplate");
}

export async function downloadProjectArchive(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/archive`), {
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "api.downloadArchive");
  return response.blob();
}
