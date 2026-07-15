import { describe, expect, it } from "vitest";
import {
  AI_RUNTIME_BUILD_ID,
  AI_RUNTIME_PROTOCOL_VERSION,
  isAiHostToRuntimeMessage,
  isAiRuntimeBootstrapInit,
  isAiRuntimeToHostMessage
} from "@/features/ai/protocol";

describe("AI Runtime protocol validation", () => {
  const bootstrap = {
    type: "toss.ai.runtime.initialize",
    protocolVersion: AI_RUNTIME_PROTOCOL_VERSION,
    buildId: AI_RUNTIME_BUILD_ID,
    sessionId: "session-1",
    nonce: "nonce-1",
    parentOrigin: "https://toss.example.test",
    locale: "en",
    connection: { kind: "fake" }
  } as const;

  it("requires the exact protocol and build identifier", () => {
    expect(isAiRuntimeBootstrapInit(bootstrap)).toBe(true);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, protocolVersion: 1 })).toBe(false);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, buildId: "stale-build" })).toBe(false);
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, locale: "fr" })).toBe(false);
  });

  it("rejects unknown fields and generic network messages", () => {
    expect(isAiRuntimeBootstrapInit({ ...bootstrap, credential: "secret" })).toBe(false);
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.fetch",
        sessionId: "session-1",
        url: "https://example.test"
      })
    ).toBe(false);
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.set_locale",
        sessionId: "session-1",
        locale: "zh-CN"
      })
    ).toBe(true);
  });

  it("bounds prompts, deltas, and errors", () => {
    expect(
      isAiHostToRuntimeMessage({
        type: "toss.ai.host.start_turn",
        sessionId: "session-1",
        turnId: "turn-1",
        prompt: "hello"
      })
    ).toBe(true);
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.assistant_delta",
        sessionId: "session-1",
        turnId: "turn-1",
        text: "x".repeat(4_097)
      })
    ).toBe(false);
    expect(
      isAiRuntimeToHostMessage({
        type: "toss.ai.runtime.error",
        sessionId: "session-1",
        code: "failed",
        message: "x".repeat(1_025)
      })
    ).toBe(false);
  });
});
