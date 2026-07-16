import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  AdminAuthSettingsResponse,
  CreatePatInput,
  CreatePatResponse,
  OrgGroupRoleMapping,
  PersonalAccessTokenListResponse,
  UpsertAdminAuthSettingsInput,
  UpsertOrgGroupRoleMappingInput
} from "@/lib/api/types";

export async function listPersonalAccessTokens() {
  const response = await fetch(apiUrl("/v1/profile/security/tokens"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<PersonalAccessTokenListResponse>(response, "api.listTokens");
}

export async function createPersonalAccessToken(input: CreatePatInput) {
  const response = await fetch(apiUrl("/v1/profile/security/tokens"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ label: input.label, expires_at: input.expires_at ?? null })
  });
  return parseJsonOrThrow<CreatePatResponse>(response, "api.createToken");
}

export async function revokePersonalAccessToken(tokenId: string) {
  const response = await fetch(apiUrl(`/v1/profile/security/tokens/${tokenId}`), {
    method: "DELETE",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "api.revokeToken");
}

export async function listOrgGroupRoleMappings(organizationId: string) {
  const response = await fetch(
    apiUrl(`/v1/admin/orgs/${organizationId}/oidc-group-role-mappings`),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<OrgGroupRoleMapping[]>(response, "api.listMappings");
}

export async function upsertOrgGroupRoleMapping(
  organizationId: string,
  input: UpsertOrgGroupRoleMappingInput
) {
  const response = await fetch(
    apiUrl(`/v1/admin/orgs/${organizationId}/oidc-group-role-mappings`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(input)
    }
  );
  return parseJsonOrThrow<OrgGroupRoleMapping>(response, "api.saveMapping");
}

export async function deleteOrgGroupRoleMapping(organizationId: string, groupName: string) {
  const safeGroupName = encodeURIComponent(groupName);
  const response = await fetch(
    apiUrl(
      `/v1/admin/orgs/${organizationId}/oidc-group-role-mappings/${safeGroupName}`
    ),
    {
      method: "DELETE",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  if (!response.ok) await throwApiError(response, "api.deleteMapping");
}

export async function getAdminAuthSettings() {
  const response = await fetch(apiUrl("/v1/admin/settings/auth"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  const parsed = await parseJsonOrThrow<AdminAuthSettingsResponse>(
    response,
    "api.loadAuthSettings"
  );
  return { ...parsed.settings, managed_fields: parsed.managed_fields };
}

export async function canAccessAdminPanel() {
  const response = await fetch(apiUrl("/v1/admin/settings/auth"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) await throwApiError(response, "api.validateAdmin");
  return true;
}

export async function upsertAdminAuthSettings(input: UpsertAdminAuthSettingsInput) {
  const response = await fetch(apiUrl("/v1/admin/settings/auth"), {
    method: "PUT",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  const parsed = await parseJsonOrThrow<AdminAuthSettingsResponse>(
    response,
    "api.saveAuthSettings"
  );
  return { ...parsed.settings, managed_fields: parsed.managed_fields };
}
