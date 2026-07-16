import {
  DEFAULT_AI_RUNTIME_PREFERENCES,
  isAiRuntimePreferences,
  type AiRuntimePreferences
} from "@/features/ai/runtimePreferences";
import {
  isAiRuntimeManagedModelSelection,
  type AiRuntimeManagedCustomModelProfile,
  type AiRuntimeManagedSelectionIdentity
} from "@/features/ai/protocol";

export const AI_ACCOUNT_SETTINGS_SCHEMA = 1 as const;

const STORAGE_PREFIX = "toss.ai.settings.v1";
const MAX_STORED_BYTES = 640 * 1024;
const MAX_PROFILE_ID_LENGTH = 128;
export const MAX_STORED_MANAGED_CUSTOM_PROFILES = 32;

export type AiAccountSettings = {
  schema: typeof AI_ACCOUNT_SETTINGS_SCHEMA;
  runtime: AiRuntimePreferences;
  managedModelSelection?: AiRuntimeManagedSelectionIdentity;
  managedCustomProfiles?: AiRuntimeManagedCustomModelProfile[];
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
  const allowed = new Set([
    "schema",
    "runtime",
    "managedModelSelection",
    "managedCustomProfiles",
    "managedModelProfileId"
  ]);
  const actual = Object.keys(record);
  if (
    !actual.every((key) => allowed.has(key)) ||
    (
      record.managedModelProfileId !== undefined &&
      record.managedModelSelection !== undefined
    ) ||
    record.schema !== AI_ACCOUNT_SETTINGS_SCHEMA ||
    !isAiRuntimePreferences(record.runtime)
  ) return null;
  let managedModelSelection: AiRuntimeManagedSelectionIdentity | undefined;
  if (record.managedModelProfileId !== undefined) {
    if (!isProfileId(record.managedModelProfileId)) return null;
    managedModelSelection = {
      kind: "recommended",
      profileId: record.managedModelProfileId
    };
  } else if (record.managedModelSelection !== undefined) {
    if (!isManagedSelectionIdentity(record.managedModelSelection)) return null;
    managedModelSelection = { ...record.managedModelSelection };
  }
  let managedCustomProfiles: AiRuntimeManagedCustomModelProfile[] | undefined;
  if (record.managedCustomProfiles !== undefined) {
    if (
      !Array.isArray(record.managedCustomProfiles) ||
      record.managedCustomProfiles.length > MAX_STORED_MANAGED_CUSTOM_PROFILES
    ) return null;
    const ids = new Set<string>();
    managedCustomProfiles = [];
    for (const profile of record.managedCustomProfiles) {
      if (
        !isStoredCustomProfile(profile) ||
        ids.has(profile.profileId)
      ) return null;
      ids.add(profile.profileId);
      managedCustomProfiles.push(profile);
    }
  }
  if (
    managedModelSelection?.kind === "custom" &&
    !managedCustomProfiles?.some(
      (profile) => profile.profileId === managedModelSelection.profileId
    )
  ) return null;
  return {
    schema: AI_ACCOUNT_SETTINGS_SCHEMA,
    runtime: { ...record.runtime },
    ...(managedModelSelection ? { managedModelSelection } : {}),
    ...(managedCustomProfiles ? { managedCustomProfiles } : {})
  };
}

function isProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH;
}

function isManagedSelectionIdentity(
  value: unknown
): value is AiRuntimeManagedSelectionIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    record.kind !== undefined && record.profileId !== undefined &&
    (record.kind === "recommended" || record.kind === "custom") &&
    isProfileId(record.profileId);
}

function isStoredCustomProfile(
  value: unknown
): value is AiRuntimeManagedCustomModelProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "profileId",
    "model",
    "contextWindow",
    "maxOutputTokens",
    "reasoning",
    "requestOverrides"
  ].sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) return false;
  return isAiRuntimeManagedModelSelection({
    kind: "custom",
    ...record
  });
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
  const serialized = JSON.stringify(settings);
  if (!parseAiAccountSettings(serialized)) throw new Error("ai_account_settings_invalid");
  if (!accountId) return;
  storage.setItem(aiAccountSettingsStorageKey(accountId), serialized);
}

export function selectedManagedCustomProfile(settings: AiAccountSettings) {
  if (settings.managedModelSelection?.kind !== "custom") return null;
  return settings.managedCustomProfiles?.find(
    (profile) => profile.profileId === settings.managedModelSelection?.profileId
  ) ?? null;
}
