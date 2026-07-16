// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  aiAccountSettingsStorageKey,
  defaultAiAccountSettings,
  loadAiAccountSettings,
  parseAiAccountSettings,
  saveAiAccountSettings
} from "@/features/ai/accountSettingsStore";

describe("AI account settings storage", () => {
  it("persists non-secret preferences and managed model selection per account", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    };
    const settings = {
      ...defaultAiAccountSettings(),
      managedModelProfileId: "model-one",
      runtime: {
        providerRequestTimeoutMs: 90_000,
        maxProviderCallsPerTurn: 8,
        maxTurnMs: 240_000,
        catalogRequestTimeoutMs: 15_000
      }
    };

    saveAiAccountSettings("account-1", settings, storage);

    expect(loadAiAccountSettings("account-1", storage)).toEqual(settings);
    expect(loadAiAccountSettings("account-2", storage)).toEqual(defaultAiAccountSettings());
    expect(values.get(aiAccountSettingsStorageKey("account-1"))).not.toContain("credential");
  });

  it("keeps anonymous settings in memory and removes corrupt account data", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    };
    const settings = defaultAiAccountSettings();

    saveAiAccountSettings(null, settings, storage);
    expect(storage.setItem).not.toHaveBeenCalled();
    values.set(aiAccountSettingsStorageKey("account-1"), "not-json");
    expect(loadAiAccountSettings("account-1", storage)).toEqual(settings);
    expect(storage.removeItem).toHaveBeenCalledWith(aiAccountSettingsStorageKey("account-1"));
  });

  it("rejects unknown fields, secrets, and unsafe preference values", () => {
    const settings = defaultAiAccountSettings();
    expect(parseAiAccountSettings(JSON.stringify({ ...settings, credential: "secret" }))).toBeNull();
    expect(parseAiAccountSettings(JSON.stringify({
      ...settings,
      runtime: { ...settings.runtime, maxProviderCallsPerTurn: 100 }
    }))).toBeNull();
    expect(parseAiAccountSettings(JSON.stringify({
      ...settings,
      runtime: {
        ...settings.runtime,
        providerRequestTimeoutMs: 120_000,
        maxTurnMs: 60_000
      }
    }))).toBeNull();
  });
});
