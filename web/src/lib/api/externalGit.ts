import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  CreateExternalGitImportInput,
  CreateExternalGitRepositoryInput,
  ExternalGitBranchListResponse,
  ExternalGitCheckpointResponse,
  ExternalGitConnectionStatus,
  ExternalGitInboundJob,
  ExternalGitRepositoryOwnerListResponse,
  ExternalGitProjectLinkMutation,
  ExternalGitProjectLinkStatus,
  ExternalGitRepositoryListResponse,
  ExternalGitProvider,
  LinkExternalGitRepositoryInput,
  RequestExternalGitInboundSyncInput
} from "@/lib/api/types";

export function externalGitAuthorizationUrl(
  provider: ExternalGitProvider,
  returnTo?: string
) {
  const path = provider.authorization_path;
  if (!path?.startsWith("/v1/external-git/")) return null;
  const params = new URLSearchParams();
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    params.set("return_to", returnTo);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return apiUrl(`${path}${query}`);
}

export async function getExternalGitConnectionStatus(providerId: string) {
  const response = await fetch(
    apiUrl(`/v1/external-git/providers/${encodeURIComponent(providerId)}/connection`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ExternalGitConnectionStatus>(response, "api.externalGitStatus");
}

export async function disconnectExternalGitConnection(providerId: string) {
  const response = await fetch(
    apiUrl(`/v1/external-git/providers/${encodeURIComponent(providerId)}/connection`),
    {
      method: "DELETE",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  if (!response.ok) await throwApiError(response, "api.externalGitDisconnect");
}

export async function listExternalGitRepositoryOwners(
  providerId: string,
  search?: string,
  page = 1
) {
  const params = new URLSearchParams({ per_page: "100", page: String(page) });
  if (search?.trim()) params.set("search", search.trim());
  const response = await fetch(
    apiUrl(
      `/v1/external-git/providers/${encodeURIComponent(providerId)}/owners?${params.toString()}`
    ),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ExternalGitRepositoryOwnerListResponse>(
    response,
    "api.externalGitOwners"
  );
}

export async function listExternalGitRepositories(
  providerId: string,
  search?: string,
  page = 1
) {
  const params = new URLSearchParams({ per_page: "100", page: String(page) });
  if (search?.trim()) params.set("search", search.trim());
  const response = await fetch(
    apiUrl(
      `/v1/external-git/providers/${encodeURIComponent(providerId)}/repositories?${params.toString()}`
    ),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ExternalGitRepositoryListResponse>(
    response,
    "api.externalGitRepositories"
  );
}

export async function listExternalGitRepositoryBranches(
  providerId: string,
  repositoryId: string,
  search?: string,
  page = 1
) {
  const params = new URLSearchParams({ per_page: "100", page: String(page) });
  if (search?.trim()) params.set("search", search.trim());
  const response = await fetch(
    apiUrl(
      `/v1/external-git/providers/${encodeURIComponent(providerId)}/repositories/${encodeURIComponent(repositoryId)}/branches?${params.toString()}`
    ),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ExternalGitBranchListResponse>(
    response,
    "api.externalGitBranches"
  );
}

export async function listLinkedExternalGitRepositoryBranches(projectId: string, search?: string) {
  const params = new URLSearchParams({ per_page: "100" });
  if (search?.trim()) params.set("search", search.trim());
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/external-git/branches?${params.toString()}`),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ExternalGitBranchListResponse>(
    response,
    "api.externalGitBranches"
  );
}

export async function createExternalGitImport(input: CreateExternalGitImportInput) {
  const response = await fetch(apiUrl("/v1/external-git/imports"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ExternalGitInboundJob>(response, "api.externalGitImport");
}

export async function getExternalGitInboundJob(jobId: string) {
  const response = await fetch(apiUrl(`/v1/external-git/jobs/${jobId}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ExternalGitInboundJob>(response, "api.externalGitImportStatus");
}

export async function requestExternalGitInboundSync(projectId: string, branch: string) {
  const input: RequestExternalGitInboundSyncInput = { branch };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/sync`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ExternalGitInboundJob>(response, "api.externalGitInboundSync");
}

export async function getExternalGitProjectStatus(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/status`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ExternalGitProjectLinkStatus>(response, "api.externalGitProjectStatus");
}

export async function createExternalGitRepository(
  projectId: string,
  input: CreateExternalGitRepositoryInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/create`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ExternalGitProjectLinkMutation>(
    response,
    "api.externalGitCreateRepository"
  );
}

export async function linkExternalGitRepository(
  projectId: string,
  provider: string,
  repositoryId: string
) {
  const input: LinkExternalGitRepositoryInput = {
    provider,
    repository_id: repositoryId
  };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/link`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<ExternalGitProjectLinkMutation>(
    response,
    "api.externalGitLinkRepository"
  );
}

export async function unlinkExternalGitRepository(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/unlink`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "api.externalGitUnlinkRepository");
}

export async function requestExternalGitCheckpoint(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/external-git/checkpoint`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (response.status === 204) return null;
  return parseJsonOrThrow<ExternalGitCheckpointResponse>(
    response,
    "api.externalGitCheckpoint"
  );
}
