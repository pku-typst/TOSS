import { managedAiRuntimeUrls } from "@/ai-runtime/networkPolicy";
import type { AiRuntimeServerPolicy } from "@/features/ai/runtimeConfig";
import type { AiRuntimePreferences } from "@/features/ai/runtimePreferences";

type ManagedPolicy = Extract<AiRuntimeServerPolicy, { kind: "managed_catalog" }>;

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 4_096;

export type ManagedCatalogFailureCode =
  | "managed_catalog_auth_rejected"
  | "managed_catalog_access_denied"
  | "managed_catalog_request_failed"
  | "managed_catalog_invalid_response";

export class ManagedCatalogError extends Error {
  readonly code: ManagedCatalogFailureCode;
  readonly status: number | null;

  constructor(code: ManagedCatalogFailureCode, status: number | null = null) {
    super(code);
    this.name = "ManagedCatalogError";
    this.code = code;
    this.status = status;
  }
}

function optionalPositiveInteger(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function parseCatalogModels(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length > MAX_DISCOVERED_MODELS) return null;
  const ids = new Set<string>();
  const models = [];
  for (const entry of data) {
    if (
      typeof entry !== "object" || entry === null || Array.isArray(entry) ||
      typeof (entry as { id?: unknown }).id !== "string"
    ) return null;
    const id = (entry as { id: string }).id;
    if (id.length === 0 || id.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(id)) return null;
    if (ids.has(id)) return null;
    const maxInputTokens = optionalPositiveInteger(
      (entry as { max_input_tokens?: unknown }).max_input_tokens
    );
    const maxOutputTokens = optionalPositiveInteger(
      (entry as { max_output_tokens?: unknown }).max_output_tokens
    );
    if (maxInputTokens === null || maxOutputTokens === null) return null;
    ids.add(id);
    models.push({
      id,
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    });
  }
  return { ids, models };
}

export async function discoverManagedCatalog(
  policy: ManagedPolicy,
  credential: string,
  preferences: AiRuntimePreferences
) {
  if (!credential || credential.length > 16_384) {
    throw new ManagedCatalogError("managed_catalog_auth_rejected");
  }
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    preferences.catalogRequestTimeoutMs
  );
  try {
    const response = await fetch(managedAiRuntimeUrls(policy.provider).models, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`
      },
      signal: controller.signal
    });
    if (response.status === 401) {
      throw new ManagedCatalogError("managed_catalog_auth_rejected", response.status);
    }
    if (response.status === 403) {
      throw new ManagedCatalogError("managed_catalog_access_denied", response.status);
    }
    if (!response.ok) {
      throw new ManagedCatalogError("managed_catalog_request_failed", response.status);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
      throw new ManagedCatalogError("managed_catalog_invalid_response", response.status);
    }
    const raw = await response.text();
    if (raw.length === 0 || raw.length > MAX_CATALOG_BYTES) {
      throw new ManagedCatalogError("managed_catalog_invalid_response", response.status);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ManagedCatalogError("managed_catalog_invalid_response", response.status);
    }
    const discovered = parseCatalogModels(value);
    if (!discovered) {
      throw new ManagedCatalogError("managed_catalog_invalid_response", response.status);
    }
    return {
      models: discovered.models,
      availableRecommendedProfileIds: policy.modelProfiles
        .filter((profile) => discovered.ids.has(profile.model))
        .map((profile) => profile.id)
    };
  } catch (error) {
    if (error instanceof ManagedCatalogError) throw error;
    throw new ManagedCatalogError("managed_catalog_request_failed");
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
