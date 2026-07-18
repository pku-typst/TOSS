import { describe, expect, it } from "vitest";
import type { CompileDiagnostic } from "@/lib/typst";
import { hasCompilationFailure } from "@/pages/workspace/components/PreviewPanel";

function diagnostic(severity: CompileDiagnostic["severity"]): CompileDiagnostic {
  return {
    severity,
    message: severity,
    raw: severity,
  };
}

describe("hasCompilationFailure", () => {
  it("distinguishes successful diagnostics from compilation errors", () => {
    expect(hasCompilationFailure([diagnostic("warning")], [])).toBe(false);
    expect(hasCompilationFailure([diagnostic("info")], [])).toBe(false);
    expect(hasCompilationFailure([diagnostic("error")], [])).toBe(true);
    expect(hasCompilationFailure([], ["compiler failed"])).toBe(true);
  });
});
