// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAiAccountConfiguration } from "@/features/ai/accountConfiguration";
import { defaultAiAccountSettings } from "@/features/ai/accountSettingsStore";

describe("useAiAccountConfiguration", () => {
  beforeEach(() => window.localStorage.clear());

  it("synchronizes settings consumers for the same account", () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const first = renderHook(() => useAiAccountConfiguration(accountId, window.location.origin));
    const second = renderHook(() => useAiAccountConfiguration(accountId, window.location.origin));
    const settings = {
      ...defaultAiAccountSettings(),
      runtime: {
        ...defaultAiAccountSettings().runtime,
        maxProviderCallsPerTurn: 7
      }
    };

    act(() => first.result.current.setSettings(settings));

    expect(first.result.current.configuration.settings).toEqual(settings);
    expect(second.result.current.configuration.settings).toEqual(settings);
    first.unmount();
    second.unmount();
  });
});
