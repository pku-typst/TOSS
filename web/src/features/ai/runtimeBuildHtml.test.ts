import { describe, expect, it } from "vitest";
import {
  AI_RUNTIME_NONCE_MARKER,
  AI_RUNTIME_POLICY_MARKER,
  renderAiRuntimeEntry,
} from "../../../aiRuntimeHtml";

const template = `<!doctype html>
<html><head>
<!-- TOSS_AI_RUNTIME_CSP -->
<!-- TOSS_AI_RUNTIME_SCRIPT -->
</head><body></body></html>`;

describe("AI Runtime entry template", () => {
  it("renders the Core entry contract without parsing generated HTML", () => {
    const html = renderAiRuntimeEntry(template, {
      kind: "core",
      scriptSrc: "/_ai-runtime/assets/bootstrap-a1b2c3.js",
    });

    expect(html).toContain(AI_RUNTIME_NONCE_MARKER);
    expect(html).toContain(AI_RUNTIME_POLICY_MARKER);
    expect(html).toContain(
      'src="/_ai-runtime/assets/bootstrap-a1b2c3.js"',
    );
    expect(html).not.toContain("TOSS_AI_RUNTIME_CSP");
    expect(html).not.toContain("TOSS_AI_RUNTIME_SCRIPT");
  });

  it("renders a self-contained static entry without replacement semantics", () => {
    const html = renderAiRuntimeEntry(template, {
      kind: "static",
      scriptSource: 'console.log("$&", "</script>");',
      nonce: "0123456789abcdef0123456789abcdef",
      encodedPolicy: "eyJraW5kIjoidXNlcl9kZWZpbmVkIn0",
      connectSources: [
        "https:",
        "http://localhost:*",
        "http://127.0.0.1:*",
      ],
    });

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('nonce="0123456789abcdef0123456789abcdef"');
    expect(html).toContain(
      'data-toss-ai-policy="eyJraW5kIjoidXNlcl9kZWZpbmVkIn0"',
    );
    expect(html).toContain('console.log("$&", "<\\/script>");');
    expect(html).not.toContain("__TOSS_AI_RUNTIME_");
  });

  it("rejects missing or duplicated template slots", () => {
    expect(() =>
      renderAiRuntimeEntry("<html></html>", {
        kind: "core",
        scriptSrc: "/runtime.js",
      }),
    ).toThrow("exactly one");
    expect(() =>
      renderAiRuntimeEntry(`${template}\n<!-- TOSS_AI_RUNTIME_SCRIPT -->`, {
        kind: "core",
        scriptSrc: "/runtime.js",
      }),
    ).toThrow("exactly one");
  });

  it("escapes Core URLs and rejects raw CSP fragments", () => {
    const html = renderAiRuntimeEntry(template, {
      kind: "core",
      scriptSrc: '/_ai-runtime/runtime.js?value="<&',
    });
    expect(html).toContain('src="/_ai-runtime/runtime.js?value=&quot;&lt;&amp;"');

    expect(() =>
      renderAiRuntimeEntry(template, {
        kind: "static",
        scriptSource: "",
        nonce: "0123456789abcdef0123456789abcdef",
        encodedPolicy: "e30",
        connectSources: ["https://provider.example; script-src *"],
      }),
    ).toThrow("connect sources are invalid");
  });
});
