import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  CreateBuiltinTemplateProjectInput,
  CreateOrganizationInput,
  CreateProjectCopyInput,
  CreateProjectInput,
  Organization,
  OrganizationListResponse,
  OrganizationMembershipListResponse,
  Project,
  ProjectListResponse,
  TemplateGalleryResponse,
  UpdateProjectArchivedInput,
  UpdateProjectNameInput
} from "@/lib/api/types";

export async function listProjects(input?: { includeArchived?: boolean; q?: string }) {
  const params = new URLSearchParams();
  if (typeof input?.includeArchived === "boolean") {
    params.set("include_archived", input.includeArchived ? "true" : "false");
  }
  if (input?.q?.trim()) params.set("q", input.q.trim());
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(apiUrl(`/v1/projects${query}`), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProjectListResponse>(response, "api.loadProjects");
}

export async function listTemplateGallery() {
  const response = await fetch(apiUrl("/v1/templates"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<TemplateGalleryResponse>(response, "api.loadTemplates");
}

export async function createProjectFromBuiltinTemplate(
  templateId: string,
  input: CreateBuiltinTemplateProjectInput
) {
  const response = await fetch(
    apiUrl(`/v1/templates/builtin/${encodeURIComponent(templateId)}/projects`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<Project>(response, "api.createFromTemplate");
}

export async function createProject(input: CreateProjectInput) {
  const response = await fetch(apiUrl("/v1/projects"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Project>(response, "api.createProject");
}

export async function copyProject(projectId: string, input: CreateProjectCopyInput) {
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/copy`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Project>(response, "api.copyProject");
}

export async function renameProject(projectId: string, name: string) {
  const input: UpdateProjectNameInput = { name };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.renameProject");
}

export async function setProjectArchived(projectId: string, archived: boolean) {
  const input: UpdateProjectArchivedInput = { archived };
  const response = await fetch(apiUrl(`/v1/projects/${projectId}/archive`), {
    method: "PATCH",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    await throwApiError(response, archived ? "api.archiveProject" : "api.unarchiveProject");
  }
}

export async function listMyOrganizations() {
  const response = await fetch(apiUrl("/v1/organizations/mine"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<OrganizationMembershipListResponse>(
    response,
    "api.listMemberships"
  );
}

export async function listOrganizations() {
  const response = await fetch(apiUrl("/v1/organizations"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<OrganizationListResponse>(
    response,
    "api.listOrganizations"
  );
}

export async function createOrganization(input: CreateOrganizationInput) {
  const response = await fetch(apiUrl("/v1/organizations"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  return parseJsonOrThrow<Organization>(response, "api.createOrganization");
}
