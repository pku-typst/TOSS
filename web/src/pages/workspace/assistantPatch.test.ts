import { describe, expect, it } from "vitest";
import {
  createAssistantUnifiedDiff,
  parseAssistantUnifiedDiff
} from "@/pages/workspace/assistantPatch";

describe("createAssistantUnifiedDiff", () => {
  it("creates a focused canonical review diff for a full-file replacement", () => {
    expect(createAssistantUnifiedDiff(
      "main.typ",
      "alpha\nbeta\ngamma\n",
      "alpha\nrevised\ngamma\n"
    )).toEqual({
      ok: true,
      candidate: {
        candidateText: "alpha\nrevised\ngamma\n",
        canonicalPatch: [
          "--- a/main.typ",
          "+++ b/main.typ",
          "@@ -1,3 +1,3 @@",
          " alpha",
          "-beta",
          "+revised",
          " gamma"
        ].join("\n"),
        addedLines: 1,
        removedLines: 1,
        hunkCount: 1
      }
    });
  });

  it("makes a final-newline change visible in the review diff", () => {
    const result = createAssistantUnifiedDiff("main.typ", "= Title\n", "= Title");
    expect(result).toMatchObject({
      ok: true,
      candidate: {
        canonicalPatch: expect.stringContaining(
          "-= Title\n+= Title\n\\ No newline at end of file"
        ),
        addedLines: 1,
        removedLines: 1
      }
    });
  });

  it("rejects unchanged and over-line-limit replacements before diffing", () => {
    expect(createAssistantUnifiedDiff("main.typ", "same", "same")).toEqual({
      ok: false,
      reason: "patch_no_effect"
    });
    expect(createAssistantUnifiedDiff(
      "main.typ",
      "base",
      Array.from({ length: 401 }, (_, index) => `line ${index}`).join("\n")
    )).toEqual({ ok: false, reason: "patch_lines" });
  });

  it.each([
    {
      name: "separated replacements",
      base: Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
      candidate: Array.from(
        { length: 14 },
        (_, index) => index === 1
          ? "early replacement"
          : index === 12
            ? "late replacement"
            : `line ${index + 1}`
      ).join("\n") + "\n"
    },
    {
      name: "insert and delete",
      base: "alpha\nbeta\ngamma\ndelta\n",
      candidate: "preface\nalpha\ngamma\ndelta\nepilogue\n"
    }
  ])("round-trips the generated $name diff through the exact parser", ({ base, candidate }) => {
    const generated = createAssistantUnifiedDiff("main.typ", base, candidate);
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const parsed = parseAssistantUnifiedDiff(
      "main.typ",
      base,
      generated.candidate.canonicalPatch
    );
    expect(parsed).toMatchObject({
      ok: true,
      candidate: { candidateText: candidate }
    });
  });
});

describe("parseAssistantUnifiedDiff", () => {
  it("applies ordered exact-context hunks and preserves the source newline style", () => {
    const result = parseAssistantUnifiedDiff(
      "main.typ",
      "#set document(\r\n  title: [Old],\r\n)\r\n\r\n= Intro\r\nBody\r\n",
      [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,3 +1,4 @@",
        " #set document(",
        "-  title: [Old],",
        "+  title: [New],",
        "+  author: [Ada],",
        " )",
        "@@ -5,2 +6,2 @@",
        " = Intro",
        "-Body",
        "+Updated body"
      ].join("\n")
    );

    expect(result).toEqual({
      ok: true,
      candidate: {
        candidateText:
          "#set document(\r\n  title: [New],\r\n  author: [Ada],\r\n)\r\n\r\n= Intro\r\nUpdated body\r\n",
        canonicalPatch: [
          "--- a/main.typ",
          "+++ b/main.typ",
          "@@ -1,3 +1,4 @@",
          " #set document(",
          "-  title: [Old],",
          "+  title: [New],",
          "+  author: [Ada],",
          " )",
          "@@ -5,2 +6,2 @@",
          " = Intro",
          "-Body",
          "+Updated body"
        ].join("\n"),
        addedLines: 3,
        removedLines: 2,
        hunkCount: 2
      }
    });
  });

  it("canonicalizes model-provided hunk counts without weakening exact context", () => {
    const result = parseAssistantUnifiedDiff(
      "main.typ",
      "#import \"theme.typ\"\n\n#set page()\n#set text()\n",
      [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,2 +1,3 @@",
        " #import \"theme.typ\"",
        " ",
        "+#set document(title: [Example])",
        " #set page()",
        " #set text()"
      ].join("\n")
    );

    expect(result).toEqual({
      ok: true,
      candidate: {
        candidateText:
          "#import \"theme.typ\"\n\n#set document(title: [Example])\n#set page()\n#set text()\n",
        canonicalPatch: [
          "--- a/main.typ",
          "+++ b/main.typ",
          "@@ -1,4 +1,5 @@",
          " #import \"theme.typ\"",
          " ",
          "+#set document(title: [Example])",
          " #set page()",
          " #set text()"
        ].join("\n"),
        addedLines: 1,
        removedLines: 0,
        hunkCount: 1
      }
    });
  });

  it.each([
    {
      name: "another path",
      patch: "--- a/other.typ\n+++ b/other.typ\n@@ -1,2 +1,2 @@\n = Title\n-Old\n+New",
      reason: "patch_paths"
    },
    {
      name: "stale context",
      patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1,2 +1,2 @@\n = Other\n-Old\n+New",
      reason: "hunk_context"
    },
    {
      name: "wrong old-start anchor",
      patch: "--- a/main.typ\n+++ b/main.typ\n@@ -2,2 +8,2 @@\n = Title\n-Old\n+New",
      reason: "hunk_context"
    },
    {
      name: "context-free hunk",
      patch: "--- a/main.typ\n+++ b/main.typ\n@@ -2 +2 @@\n-Old\n+New",
      reason: "hunk_counts"
    },
    {
      name: "second file",
      patch: [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,2 +1,2 @@",
        " = Title",
        "-Old",
        "+New",
        "--- a/other.typ",
        "+++ b/other.typ"
      ].join("\n"),
      reason: "patch_syntax"
    }
  ])("rejects $name", ({ patch, reason }) => {
    expect(parseAssistantUnifiedDiff("main.typ", "= Title\nOld\n", patch)).toEqual({
      ok: false,
      reason
    });
  });
});
