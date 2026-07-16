// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  aiConnectionStorageKey,
  createStoredAiConnection,
  loadStoredAiConnections,
  parseStoredAiConnections,
  saveStoredAiConnections,
  toRuntimeConnection
} from "@/features/ai/connectionStore";

const applicationOrigin = "https://toss.example.test";

describe("AI connection profile storage", () => {
  it("normalizes non-secret metadata and derives the Runtime profile", () => {
    const connection = createStoredAiConnection(
      "connection-1",
      {
        name: "Local model",
        protocol: "openai-completions",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3:8b",
        contextWindow: "131072",
        maxOutputTokens: "8192",
        reasoning: true,
        requestOverrides: JSON.stringify({
          chat_template_kwargs: { enable_thinking: true, reasoning_budget: 8_192 }
        })
      },
      applicationOrigin
    );
    expect(toRuntimeConnection(connection)).toEqual({
      kind: "endpoint",
      connectionId: "connection-1",
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      reasoning: true,
      requestOverrides: {
        chat_template_kwargs: { enable_thinking: true, reasoning_budget: 8_192 }
      }
    });
  });

  it("rejects credentials, unknown fields, duplicate IDs, and protected overrides", () => {
    const base = {
      schema: 1,
      activeConnectionId: "connection-1",
      connections: [{
        id: "connection-1",
        name: "Model",
        protocol: "openai-completions",
        endpoint: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: false,
        requestOverrides: {}
      }]
    };
    expect(parseStoredAiConnections(JSON.stringify({ ...base, credential: "secret" }), applicationOrigin)).toBeNull();
    expect(parseStoredAiConnections(JSON.stringify({
      ...base,
      connections: [...base.connections, base.connections[0]]
    }), applicationOrigin)).toBeNull();
    expect(parseStoredAiConnections(JSON.stringify({
      ...base,
      connections: [{ ...base.connections[0], endpoint: `${applicationOrigin}/v1` }]
    }), applicationOrigin)).toBeNull();
    expect(parseStoredAiConnections(JSON.stringify({
      ...base,
      connections: [{ ...base.connections[0], requestOverrides: { messages: [] } }]
    }), applicationOrigin)).toBeNull();
    expect(parseStoredAiConnections(JSON.stringify({
      ...base,
      connections: [{
        ...base.connections[0],
        requestOverrides: { nvext: { api_key: "must-not-persist" } }
      }]
    }), applicationOrigin)).toBeNull();
  });

  it("scopes persistence by account and removes a corrupt value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    };
    const stored = {
      schema: 1 as const,
      activeConnectionId: "connection-1",
      connections: [{
        id: "connection-1",
        name: "Model",
        protocol: "openai-responses" as const,
        endpoint: "https://models.example.test/v1",
        model: "model-1",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        reasoning: true,
        requestOverrides: { reasoning: { effort: "medium" } }
      }]
    };
    saveStoredAiConnections("account-1", stored, storage);
    expect(loadStoredAiConnections("account-1", applicationOrigin, storage)).toEqual(stored);
    expect(loadStoredAiConnections("account-2", applicationOrigin, storage).connections).toEqual([]);
    values.set(aiConnectionStorageKey("account-1"), "not-json");
    expect(loadStoredAiConnections("account-1", applicationOrigin, storage).connections).toEqual([]);
    expect(storage.removeItem).toHaveBeenCalledWith(aiConnectionStorageKey("account-1"));
  });
});
