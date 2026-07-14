import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  CreateProjectShareLinkInput,
  CreateProjectShareLinkResponse,
  JoinProjectShareLinkResponse,
  ProjectAccessUserListResponse,
  ProjectOrganizationAccess,
  ProjectPermission,
  ProjectShareLink,
  ResolveProjectShareLinkResponse,
  TemporaryShareLoginInput,
  TemporaryShareLoginResponse,
  UpsertProjectOrganizationAccessInput,
  UploadProjectThumbnailInput
} from "@/lib/api/types";

export async function listProjectShareLinks(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/share-links`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectShareLink[]>(response, "api.listShareLinks");
}

export async function createProjectShareLink(
  projectId: string,
  input: CreateProjectShareLinkInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/share-links`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<CreateProjectShareLinkResponse>(response, "api.createShareLink");
}

export async function revokeProjectShareLink(projectId: string, shareLinkId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/share-links/${shareLinkId}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "api.revokeShareLink");
}

export async function listProjectOrganizationAccess(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/organization-access`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectOrganizationAccess[]>(
    response,
    "api.listOrganizationAccess"
  );
}

export async function upsertProjectOrganizationAccess(
  projectId: string,
  organizationId: string,
  permission: ProjectPermission
) {
  const input: UpsertProjectOrganizationAccessInput = { permission };
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/organization-access/${organizationId}`),
    {
      method: "PUT",
      credentials: authCredentials(),
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<ProjectOrganizationAccess>(
    response,
    "api.saveOrganizationAccess"
  );
}

export async function deleteProjectOrganizationAccess(
  projectId: string,
  organizationId: string
) {
  const response = await fetch(
    apiUrl(`/v1/projects/${projectId}/organization-access/${organizationId}`),
    {
      method: "DELETE",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  if (!response.ok) await throwApiError(response, "api.removeOrganizationAccess");
}

export async function listProjectAccessUsers(projectId: string) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/access-users`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectAccessUserListResponse>(response, "api.listAccessUsers");
}

export function projectThumbnailUrl(projectId: string, versionHint?: string) {
  const base = apiUrl(`/v1/projects/${projectId}/thumbnail`);
  if (!versionHint) return base;
  const safeVersion = encodeURIComponent(versionHint);
  return `${base}${base.includes("?") ? "&" : "?"}v=${safeVersion}`;
}

export function builtinTemplateThumbnailUrl(templateId: string) {
  return apiUrl(`/v1/templates/builtin/${encodeURIComponent(templateId)}/thumbnail`);
}

export async function uploadProjectThumbnail(
  projectId: string,
  input: UploadProjectThumbnailInput
) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/thumbnail`), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.uploadThumbnail");
}

export async function joinProjectShareLink(token: string) {
  const response = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/join`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<JoinProjectShareLinkResponse>(response, "api.joinSharedProject");
}

export async function resolveProjectShareLink(token: string) {
  const response = await fetch(apiUrl(`/v1/share/${encodeURIComponent(token)}/resolve`), {
    credentials: authCredentials(),
    headers: authHeaders(),
    cache: "no-store"
  });
  return parseJsonOrThrow<ResolveProjectShareLinkResponse>(
    response,
    "api.resolveSharedProject"
  );
}

export async function temporaryShareLogin(token: string, displayName: string) {
  const input: TemporaryShareLoginInput = { display_name: displayName };
  const response = await fetch(
    apiUrl(`/v1/share/${encodeURIComponent(token)}/temporary-login`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<TemporaryShareLoginResponse>(response, "api.startGuestSession");
}
