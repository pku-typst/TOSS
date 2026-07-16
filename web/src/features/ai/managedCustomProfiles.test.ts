// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedCustomProfile,
  managedCustomProfilesForConfig,
  requestedManagedSelection
} from "@/features/ai/managedCustomProfiles";
import { defaultAiAccountSettings } from "@/features/ai/accountSettingsStore";
import type { AuthConfig } from "@/lib/api/types";

const config = {
  kind: "managed_catalog" as const,
  provider: {
    id: "managed-provider",
    label: { en: "Provider", "zh-CN": "提供方" }
  },
  default_model_profile: "recommended-one",
  model_profiles: [{
    id: "recommended-one",
    model: "vendor/recommended-one",
    label: { en: "Recommended", "zh-CN": "推荐" }
  }],
  custom_profiles: {
    enabled: true,
    require_catalog_match: true,
    defaults: {
      context_window: 70_000,
      max_output_tokens: 5_000,
      reasoning: true,
      request_overrides: { reasoning_effort: "high" }
    },
    limits: {
      min_context_window: 8_192,
      max_context_window: 4_194_304,
      min_output_tokens: 256,
      max_output_tokens: 1_048_576
    },
    max_saved_profiles: 20
  }
} satisfies Extract<
  NonNullable<AuthConfig["ai_assistant"]>,
  { kind: "managed_catalog" }
>;

afterEach(() => vi.restoreAllMocks());

describe("managed custom profile defaults", () => {
  it("uses editable distribution-policy defaults and clamps them to live model caps", () => {
    vi.spyOn(window.crypto, "getRandomValues").mockImplementation((array) => {
      const target = array as Uint8Array;
      target.fill(1);
      return array;
    });
    expect(createManagedCustomProfile(config, {
      id: "vendor/custom",
      maxInputTokens: 65_536,
      maxOutputTokens: 4_096
    })).toEqual({
      profileId: `custom-${"01".repeat(16)}`,
      model: "vendor/custom",
      contextWindow: 65_536,
      maxOutputTokens: 4_096,
      reasoning: true,
      requestOverrides: { reasoning_effort: "high" }
    });
  });

  it("falls back to the verified default and resolves a saved custom selection", () => {
    expect(requestedManagedSelection(config, defaultAiAccountSettings())).toEqual({
      kind: "recommended",
      profileId: "recommended-one"
    });
    const custom = {
      profileId: "custom-one",
      model: "vendor/custom",
      contextWindow: 65_536,
      maxOutputTokens: 4_096,
      reasoning: false,
      requestOverrides: {}
    };
    expect(requestedManagedSelection(config, {
      ...defaultAiAccountSettings(),
      managedModelSelection: { kind: "custom", profileId: custom.profileId },
      managedCustomProfiles: [custom]
    })).toEqual({ kind: "custom", ...custom });
  });

  it("applies the distribution saved-profile bound before resolving a selection", () => {
    const limitedConfig = {
      ...config,
      custom_profiles: { ...config.custom_profiles, max_saved_profiles: 1 }
    };
    const first = {
      profileId: "custom-one",
      model: "vendor/custom-one",
      contextWindow: 65_536,
      maxOutputTokens: 4_096,
      reasoning: false,
      requestOverrides: {}
    };
    const second = { ...first, profileId: "custom-two", model: "vendor/custom-two" };
    const settings = {
      ...defaultAiAccountSettings(),
      managedModelSelection: { kind: "custom" as const, profileId: second.profileId },
      managedCustomProfiles: [first, second]
    };

    expect(managedCustomProfilesForConfig(limitedConfig, settings)).toEqual([first]);
    expect(requestedManagedSelection(limitedConfig, settings)).toEqual({
      kind: "recommended",
      profileId: "recommended-one"
    });
  });
});
