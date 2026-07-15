// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  earlyRuntimePolicy,
  installRuntimeMetaPolicy,
  lockedRuntimePolicy,
  normalizeAiRuntimeEndpoint,
  runtimeConnectSource
} from "@/features/ai/runtimePolicy";

describe("AI Runtime network policy", () => {
  afterEach(() => {
    document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((node) => node.remove());
  });

  it("normalizes HTTPS and explicit loopback endpoints", () => {
    expect(
      normalizeAiRuntimeEndpoint("https://models.example.test/v1/", "https://toss.example.test")
    ).toEqual({
      baseUrl: "https://models.example.test/v1/",
      origin: "https://models.example.test"
    });
    expect(
      normalizeAiRuntimeEndpoint("http://127.0.0.1:11434/v1", "https://toss.example.test")
    ).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      origin: "http://127.0.0.1:11434"
    });
  });

  it("rejects application, credential-bearing, parameterized, and plaintext LAN endpoints", () => {
    expect(() =>
      normalizeAiRuntimeEndpoint("https://toss.example.test/v1", "https://toss.example.test")
    ).toThrow("ai_endpoint_matches_application_origin");
    expect(() =>
      normalizeAiRuntimeEndpoint("https://secret@models.example.test/v1", "https://toss.example.test")
    ).toThrow("ai_endpoint_contains_credentials_or_parameters");
    expect(() =>
      normalizeAiRuntimeEndpoint("https://models.example.test/v1?key=secret", "https://toss.example.test")
    ).toThrow("ai_endpoint_contains_credentials_or_parameters");
    expect(() =>
      normalizeAiRuntimeEndpoint("http://192.168.1.10:11434/v1", "https://toss.example.test")
    ).toThrow("ai_endpoint_scheme_not_allowed");
  });

  it("uses no network authority for the fake Runtime and locks later code loading", () => {
    expect(runtimeConnectSource({ kind: "fake" }, "https://toss.example.test")).toEqual({
      source: "'none'",
      endpoint: null
    });
    expect(earlyRuntimePolicy("https://models.example.test")).toBe(
      "connect-src https://models.example.test"
    );
    expect(lockedRuntimePolicy("https://models.example.test")).toContain("script-src 'none'");
    expect(lockedRuntimePolicy("https://models.example.test")).toContain("worker-src 'none'");
  });

  it("installs CSP as a meta policy without exposing configuration elsewhere", () => {
    const policy = installRuntimeMetaPolicy("connect-src https://models.example.test");
    expect(policy.httpEquiv).toBe("Content-Security-Policy");
    expect(policy.content).toBe("connect-src https://models.example.test");
    expect(document.head.firstElementChild).toBe(policy);
  });
});
