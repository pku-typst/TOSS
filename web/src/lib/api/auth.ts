import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  AuthConfig,
  AuthUser,
  Experience,
  HelpContent,
  IdentityProvider,
  LocalLoginInput,
  LocalRegisterInput
} from "@/lib/api/types";

export async function getAuthConfig() {
  const response = await fetch(apiUrl("/v1/auth/config"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<AuthConfig>(response, "api.loadAuthConfig");
}

export async function getExperience() {
  const response = await fetch(apiUrl("/v1/experience"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<Experience>(response, "api.loadExperience");
}

export async function getHelpContent() {
  const response = await fetch(apiUrl("/v1/help"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<HelpContent>(response, "api.loadHelp");
}

export async function getAuthMe() {
  const response = await fetch(apiUrl("/v1/auth/me"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (response.status === 401) return null;
  if (!response.ok) await throwApiError(response, "api.loadSession");
  return (await response.json()) as AuthUser;
}

export async function localLogin(email: string, password: string) {
  const input: LocalLoginInput = { email, password };
  const response = await fetch(apiUrl("/v1/auth/local/login"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.login");
}

export async function localRegister(input: LocalRegisterInput) {
  const response = await fetch(apiUrl("/v1/auth/local/register"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input)
  });
  if (!response.ok) await throwApiError(response, "api.register");
}

export function identityLoginUrl(provider: IdentityProvider | null, returnTo?: string) {
  const path = provider?.login_path?.startsWith("/v1/auth/")
    ? provider.login_path
    : "/v1/auth/oidc/login";
  const params = new URLSearchParams();
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    params.set("return_to", returnTo);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return apiUrl(`${path}${query}`);
}

export async function logout() {
  await fetch(apiUrl("/v1/auth/logout"), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders()
  });
}
