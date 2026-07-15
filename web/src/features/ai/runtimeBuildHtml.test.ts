import { describe, expect, it } from "vitest";
import {
  AI_RUNTIME_BOOTSTRAP_MARKER,
  AI_RUNTIME_NONCE_MARKER,
  decorateAiRuntimeEntry
} from "../../../aiRuntimeHtml";

describe("AI Runtime entry contract", () => {
  it("decorates Vite's generated module entry with the bootstrap and nonce markers", () => {
    const html = decorateAiRuntimeEntry(
      '<html><head><script type="module" crossorigin src="/runtime.js"></script></head></html>'
    );

    expect(html).toContain(AI_RUNTIME_BOOTSTRAP_MARKER);
    expect(html).toContain(AI_RUNTIME_NONCE_MARKER);
  });

  it("rejects an ambiguous script surface", () => {
    expect(() => decorateAiRuntimeEntry("<html></html>")).toThrow(
      "exactly one module script"
    );
    expect(() =>
      decorateAiRuntimeEntry(
        '<script type="module"></script><script type="module"></script>'
      )
    ).toThrow("exactly one module script");
  });
});
