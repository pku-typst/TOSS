// @vitest-environment jsdom

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  type AiRuntimeBootstrapInit
} from "@/features/ai/protocol";
import { prepareRuntimeSurface, startRuntime } from "@/ai-runtime/runtime";
import { DEFAULT_RUNTIME_DESIGN_THEME } from "@/design/runtimeTheme";

const channels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

describe("AI connection surface", () => {
  it("renders one credential field without a duplicated connection summary", () => {
    document.body.innerHTML = '<div id="ai-runtime-root"></div>';
    prepareRuntimeSurface("test-nonce", "en", {
      ...DEFAULT_RUNTIME_DESIGN_THEME,
      brand: "#123456",
      radiusControl: "7px"
    });
    expect(document.documentElement.style.getPropertyValue("--toss-brand-primary")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--toss-radius-control")).toBe("7px");

    const channel = new MessageChannel();
    channels.push(channel);
    const init: AiRuntimeBootstrapInit = {
      type: "toss.ai.runtime.initialize",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId: "session-1",
      nonce: "nonce-1",
      parentOrigin: "https://toss.example.test",
      locale: "en",
      theme: DEFAULT_RUNTIME_DESIGN_THEME,
      preferences: {
        providerRequestTimeoutMs: 120_000,
        maxProviderCallsPerTurn: 12,
        maxTurnMs: 300_000,
        catalogRequestTimeoutMs: 20_000
      },
      connection: {
        kind: "endpoint",
        connectionId: "connection-1",
        protocol: "openai-completions",
        baseUrl: "https://provider.example.test/v1/",
        model: "provider/model-id",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        reasoning: true,
        requestOverrides: {}
      },
      conversation: { conversationId: "conversation-1", history: [] },
      workspace: null
    };

    startRuntime(
      channel.port1,
      init,
      { kind: "user_defined" },
      {
        baseUrl: "https://provider.example.test/v1/",
        origin: "https://provider.example.test"
      },
      (() => {
        throw new Error("provider stream should not start before submission");
      }) as StreamFn
    );

    const form = document.querySelector(".credential-form")!;
    expect(form.querySelectorAll("input[type='password']")).toHaveLength(1);
    expect(form.querySelectorAll("button")).toHaveLength(1);
    expect(form.querySelector("dl")).toBeNull();
  });

  it("offers one catalog action and one credential action after connecting", async () => {
    document.body.innerHTML = '<div id="ai-runtime-root"></div>';
    prepareRuntimeSurface("test-nonce", "en");
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      object: "list",
      data: [{ id: "vendor/model-one", object: "model" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    const channel = new MessageChannel();
    channels.push(channel);
    const policy = {
      kind: "managed_catalog" as const,
      provider: {
        id: "managed-provider",
        label: { en: "Provider", "zh-CN": "Provider" },
        credentialLabel: { en: "API key", "zh-CN": "API key" },
        protocol: "openai-completions" as const,
        baseUrl: "https://models.example.test/v1/",
        catalog: "openai-models" as const
      },
      defaultModelProfileId: "model-one",
      modelProfiles: [{
        id: "model-one",
        model: "vendor/model-one",
        label: { en: "Model one", "zh-CN": "Model one" },
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: false,
        requestOverrides: {}
      }]
    };
    const init: AiRuntimeBootstrapInit = {
      type: "toss.ai.runtime.initialize",
      protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
      buildId: AI_RUNTIME_BUILD_ID,
      sessionId: "session-2",
      nonce: "nonce-2",
      parentOrigin: "https://toss.example.test",
      locale: "en",
      theme: DEFAULT_RUNTIME_DESIGN_THEME,
      preferences: {
        providerRequestTimeoutMs: 120_000,
        maxProviderCallsPerTurn: 12,
        maxTurnMs: 300_000,
        catalogRequestTimeoutMs: 20_000
      },
      connection: { kind: "managed", modelProfileId: "model-one" },
      conversation: { conversationId: "conversation-2", history: [] },
      workspace: null
    };

    startRuntime(
      channel.port1,
      init,
      policy,
      {
        baseUrl: "https://models.example.test/v1/",
        origin: "https://models.example.test"
      },
      (() => {
        throw new Error("provider stream should not start without a turn");
      }) as StreamFn
    );

    const input = document.querySelector<HTMLInputElement>("input[type='password']")!;
    input.value = "test-key";
    document.querySelector<HTMLButtonElement>(".credential-form button")!.click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".managed-controls button")).toHaveLength(2);
    });
    expect(Array.from(
      document.querySelectorAll<HTMLButtonElement>(".managed-controls button"),
      (button) => button.dataset.action
    )).toEqual(["refresh-models", "change-credential"]);
    expect(document.querySelector<HTMLElement>(".runtime-status")!.hidden).toBe(true);

    document.querySelector<HTMLButtonElement>("[data-action='refresh-models']")!.click();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(document.querySelectorAll(".managed-controls button")).toHaveLength(2);
    });

    document.querySelector<HTMLButtonElement>("[data-action='change-credential']")!.click();
    expect(document.querySelectorAll(".managed-controls")).toHaveLength(0);
    expect(document.querySelectorAll("input[type='password']")).toHaveLength(1);
  });
});
