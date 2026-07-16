import {
  DEFAULT_AI_RUNTIME_PREFERENCES,
  isAiRuntimePreferences,
  type AiRuntimePreferences
} from "@/features/ai/runtimePreferences";

export const AI_ACCOUNT_SETTINGS_SCHEMA = 1 as const;

const STORAGE_PREFIX = "toss.ai.settings.v1";
const MAX_STORED_BYTES = 8 * 1024;
const MAX_PROFILE_ID_LENGTH = 128;

export type AiAccountSettings = {
  schema: typeof AI_ACCOUNT_SETTINGS_SCHEMA;
  runtime: AiRuntimePreferences;
  managedModelProfileId?: string;
};

export function defaultAiAccountSettings(): AiAccountSettings {
  return {
    schema: AI_ACCOUNT_SETTINGS_SCHEMA,
    runtime: { ...DEFAULT_AI_RUNTIME_PREFERENCES }
  };
}

export function aiAccountSettingsStorageKey(accountId: string) {
  return `${STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;
}

export function parseAiAccountSettings(raw: string): AiAccountSettings | null {
  if (raw.length === 0 || raw.length > MAX_STORED_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expected = record.managedModelProfileId === undefined
    ? ["schema", "runtime"]
    : ["schema", "runtime", "managedModelProfileId"];
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === [...expected].sort()[index]) ||
    record.schema !== AI_ACCOUNT_SETTINGS_SCHEMA ||
    !isAiRuntimePreferences(record.runtime) ||
    (
      record.managedModelProfileId !== undefined &&
      (
        typeof record.managedModelProfileId !== "string" ||
        record.managedModelProfileId.length === 0 ||
        record.managedModelProfileId.length > MAX_PROFILE_ID_LENGTH
      )
    )
  ) return null;
  return {
    schema: AI_ACCOUNT_SETTINGS_SCHEMA,
    runtime: { ...record.runtime },
    ...(typeof record.managedModelProfileId === "string"
      ? { managedModelProfileId: record.managedModelProfileId }
      : {})
  };
}

export function loadAiAccountSettings(
  accountId: string | null,
  storage: Pick<Storage, "getItem" | "removeItem"> = window.localStorage
) {
  if (!accountId) return defaultAiAccountSettings();
  const key = aiAccountSettingsStorageKey(accountId);
  const raw = storage.getItem(key);
  if (!raw) return defaultAiAccountSettings();
  const parsed = parseAiAccountSettings(raw);
  if (parsed) return parsed;
  storage.removeItem(key);
  return defaultAiAccountSettings();
}

export function saveAiAccountSettings(
  accountId: string | null,
  settings: AiAccountSettings,
  storage: Pick<Storage, "setItem"> = window.localStorage
) {
  if (!accountId) return;
  storage.setItem(aiAccountSettingsStorageKey(accountId), JSON.stringify(settings));
}
