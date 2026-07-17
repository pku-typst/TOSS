import {
  localizeApiErrorDetail,
  readStoredLocale,
  translate
} from "@/lib/i18n";
import { apiErrorCodes } from "@/lib/api/generated";
import type { ApiErrorCode, ApiErrorPayload } from "@/lib/api/types";
import {
  observeProtocolResponse,
  protocolEpochHeaders
} from "@/lib/protocolCompatibility";

const API_BASE = (import.meta.env.VITE_CORE_API_URL as string | undefined)?.trim() ?? "";

export const AUTH_REQUIRED_EVENT = "toss:auth-required";

let shareAccessToken: string | null = null;
let guestShareSession: string | null = null;

export function apiUrl(path: string) {
  if (!API_BASE) return path;
  return `${API_BASE.replace(/\/$/, "")}${path}`;
}

export function coreApiBaseUrl() {
  return API_BASE;
}

export function authCredentials(): RequestCredentials {
  return "include";
}

export function authHeaders(extra?: Record<string, string>) {
  const headers = protocolEpochHeaders(extra);
  if (shareAccessToken) headers["x-share-token"] = shareAccessToken;
  if (guestShareSession) headers["x-guest-session"] = guestShareSession;
  return headers;
}

export function encodePathPreservingSlashes(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

const apiErrorCodeSet: ReadonlySet<string> = new Set(apiErrorCodes);

type ParsedApiError = {
  code: ApiErrorCode | null;
  message: string | null;
};

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode | null;

  constructor(message: string, status: number, code: ApiErrorCode | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && apiErrorCodeSet.has(value);
}

export function parseApiErrorPayload(payload: unknown): ParsedApiError {
  if (!payload || typeof payload !== "object") {
    return { code: null, message: null };
  }
  const record = payload as Record<string, unknown>;
  const code = isApiErrorCode(record.code) ? record.code : null;
  const fields = [record.message, record.error, record.detail];
  for (const value of fields) {
    if (typeof value === "string" && value.trim()) {
      return { code, message: value.trim() };
    }
  }
  return { code, message: null };
}

async function responseError(response: Response): Promise<ParsedApiError> {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    return parseApiErrorPayload(payload);
  }
  const text = (await response.text().catch(() => "")).trim();
  return { code: null, message: text || null };
}

export async function throwApiError(response: Response, operationKey: string): Promise<never> {
  observeProtocolResponse(response);
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
  const error = await responseError(response);
  const locale = readStoredLocale();
  const detail = localizeApiErrorDetail(
    locale,
    error.code,
    error.message,
    response.status
  );
  throw new ApiError(
    `${translate(locale, operationKey)}: ${detail}`,
    response.status,
    error.code
  );
}

export async function parseJsonOrThrow<T>(response: Response, operationKey: string): Promise<T> {
  observeProtocolResponse(response);
  if (!response.ok) await throwApiError(response, operationKey);
  return (await response.json()) as T;
}

export function setShareAccessContext(input: {
  shareToken?: string | null;
  guestSession?: string | null;
}) {
  shareAccessToken = input.shareToken?.trim() || null;
  guestShareSession = input.guestSession?.trim() || null;
}

export function clearShareAccessContext() {
  shareAccessToken = null;
  guestShareSession = null;
}
