import { describe, expect, it, vi } from "vitest";
import {
  createAiWorkspacePort,
  type AiWorkspaceCandidateCompileResult,
  type AiWorkspaceToolSource
} from "@/pages/workspace/assistantWorkspacePort";
import type {
  AssistantEditProposal,
  AssistantEditReviewRequestResult
} from "@/pages/workspace/assistantEditReview";
import type { AiTypstPackageInspector } from "@/features/ai/typstPackageInspector";

function source(): AiWorkspaceToolSource {
  return {
    scopeId: "generation-1:live",
    projectType: "typst",
    mode: "live",
    entryFilePath: "main.typ",
    activePath: "main.typ",
    nodes: [
      { path: "assets", kind: "directory" },
      { path: "assets/logo.png", kind: "file" },
      { path: "chapters", kind: "directory" },
      { path: "chapters/intro.typ", kind: "file" },
      { path: "main.typ", kind: "file" }
    ],
    documents: {
      "chapters/intro.typ": "= Introduction\nCommunity text",
      "main.typ": "#set document(title: [Stale title])\nStale body"
    },
    activeDocument: {
      path: "main.typ",
      text: "#set document(title: [Current title])\nAlice Example\nCurrent body"
    },
    documentIdentities: {
      "chapters/intro.typ": { id: "doc-intro", pathRevision: 1, collaborationRevision: 1 },
      "main.typ": { id: "doc-main", pathRevision: 2, collaborationRevision: 7 }
    }
  };
}

function portFor(
  getSource: () => AiWorkspaceToolSource,
  requestEditReview: (
    proposal: Omit<AssistantEditProposal, "id">,
    signal?: AbortSignal
  ) => AssistantEditReviewRequestResult = () => ({
    outcome: "pending",
    reviewId: "review-default"
  }),
  allowEdits = true,
  verifyCandidate: (
    candidate: { path: string; baseText: string; candidateText: string },
    signal?: AbortSignal
  ) => Promise<AiWorkspaceCandidateCompileResult> = async () => ({
    outcome: "completed",
    revision: compileRevision,
    errors: [],
    diagnostics: []
  }),
  isCandidateRevisionCurrent: (revision: object) => boolean =
    (revision) => revision === compileRevision,
  typstPackageInspector?: AiTypstPackageInspector
) {
  return createAiWorkspacePort({
    scopeId: "generation-1:live",
    projectType: "typst",
    mode: "live",
    allowEdits,
    typstPackageInspector,
    getContextSnapshot: () => ({
      schema: 1,
      project_name: "Example",
      project_type: "typst",
      mode: "live",
      entry_file_path: "main.typ",
      active_path: "main.typ",
      access: allowEdits ? "edit" : "read",
      workspace_state: "ready",
      active_document_state: "ready",
      files: { total: 3, text: 2, assets: 1 },
      compilation: { state: "succeeded", errors: 0, warnings: 0 },
      pending_edit_review: false,
      last_edit_review: null
    }),
    getCompilationSnapshot: () => ({
      state: "failed",
      diagnosticsCurrent: true,
      errors: ["main.typ:2: unexpected token"],
      diagnostics: [{
        severity: "error",
        message: "unexpected token",
        path: "main.typ",
        line: 2,
        column: 1
      }]
    }),
    getSource,
    verifyCandidate,
    isCandidateRevisionCurrent,
    requestEditReview
  });
}

const compileRevision = {};

describe("AI Workspace tool port", () => {
  it("projects bounded current compilation diagnostics without starting a compile", async () => {
    const port = portFor(source);

    await expect(port.execute({
      tool: "inspect_compilation",
      arguments: {}
    })).resolves.toEqual({
      outcome: "success",
      result: {
        project_type: "typst",
        entry_file_path: "main.typ",
        active_path: "main.typ",
        state: "failed",
        diagnostics_current: true,
        errors: ["main.typ:2: unexpected token"],
        diagnostics: [{
          severity: "error",
          message: "unexpected token",
          path: "main.typ",
          line: 2,
          column: 1
        }],
        truncated: false
      }
    });
  });

  it("composes read-only Typst package tools without exposing them to other projects", async () => {
    const execute = vi.fn(async () => ({
      outcome: "success" as const,
      result: {
        package_spec: "@preview/fixture:1.2.3",
        package_digest: `sha256:${"a".repeat(64)}`,
        manifest_path: "typst.toml" as const,
        entries: [],
        offset: 0,
        total: 0,
        next_offset: null
      }
    }));
    const dispose = vi.fn();
    const port = portFor(
      source,
      () => ({ outcome: "pending", reviewId: "review-package" }),
      true,
      undefined,
      undefined,
      { execute, dispose }
    );

    expect(port.capabilities.tools).toEqual(expect.arrayContaining([
      "list_typst_package_files",
      "read_typst_package_file",
      "search_typst_package_text"
    ]));
    await expect(port.execute({
      tool: "list_typst_package_files",
      arguments: { package_spec: "@preview/fixture:1.2.3" }
    })).resolves.toMatchObject({ outcome: "success" });
    expect(execute).toHaveBeenCalledOnce();
    port.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("exposes the Workspace-owned context projection", () => {
    const port = portFor(source);
    expect(port.getContextSnapshot()).toMatchObject({
      project_name: "Example",
      active_path: "main.typ",
      compilation: { state: "succeeded" }
    });
  });

  it("lists bounded project entries and classifies text separately from assets", async () => {
    const port = portFor(source);
    const response = await port.execute({
      tool: "list_project_files",
      arguments: { offset: 1, limit: 3 }
    });

    expect(response.outcome).toBe("success");
    if (response.outcome !== "success") return;
    expect(response.result).toMatchObject({
      project_type: "typst",
      mode: "live",
      entry_file_path: "main.typ",
      active_path: "main.typ",
      offset: 1,
      total: 5,
      next_offset: 4,
      entries: [
        { path: "assets/logo.png", kind: "asset" },
        { path: "chapters", kind: "directory" },
        { path: "chapters/intro.typ", kind: "text" }
      ]
    });
  });

  it("reads the active Yjs/editor projection with line numbers and a content snapshot", async () => {
    const port = portFor(source);
    const response = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 2 }
    });

    expect(response.outcome).toBe("success");
    if (response.outcome !== "success") return;
    expect(response.result).toMatchObject({
      path: "main.typ",
      start_line: 1,
      end_line: 2,
      total_lines: 3,
      has_more: true,
      content_truncated: false,
      numbered_content:
        "1 | #set document(title: [Current title])\n2 | Alice Example"
    });
    expect("snapshot_id" in response.result && response.result.snapshot_id)
      .toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it("searches the latest active text and returns numbered excerpts", async () => {
    const port = portFor(source);
    const response = await port.execute({
      tool: "search_project_text",
      arguments: { query: "current", max_results: 10 }
    });

    expect(response).toEqual({
      outcome: "success",
      result: {
        query: "current",
        case_sensitive: false,
        files_searched: 2,
        matches: [
          {
            path: "main.typ",
            line: 1,
            column: 23,
            numbered_excerpt: "1 | #set document(title: [Current title])"
          },
          {
            path: "main.typ",
            line: 3,
            column: 1,
            numbered_excerpt: "3 | Current body"
          }
        ],
        truncated: false
      }
    });
  });

  it("rejects traversal, binary reads, stale scopes, and aborted calls", async () => {
    let current = source();
    const port = portFor(() => current);
    await expect(port.execute({
      tool: "read_project_file",
      arguments: { path: "../secret" }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_invalid_path" }
    });
    await expect(port.execute({
      tool: "read_project_file",
      arguments: { path: "assets/logo.png" }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_file_not_text" }
    });

    current = { ...current, scopeId: "generation-2:live" };
    await expect(port.execute({
      tool: "list_project_files",
      arguments: {}
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_scope_changed" }
    });

    current = source();
    const controller = new AbortController();
    controller.abort();
    await expect(port.execute({
      tool: "search_project_text",
      arguments: { query: "title" }
    }, controller.signal)).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_request_cancelled" }
    });
  });

  it("validates a snapshot-bound unified diff before entering review", async () => {
    const events: string[] = [];
    let reviewed: Omit<AssistantEditProposal, "id"> | null = null;
    const port = portFor(source, (proposal) => {
      events.push("review");
      reviewed = proposal;
      return { outcome: "pending", reviewId: "review-patch" };
    }, true, async ({ candidateText }) => {
      events.push("compile");
      expect(candidateText).toContain("Alice Author");
      return {
        outcome: "completed",
        revision: compileRevision,
        errors: [],
        diagnostics: [{
          severity: "warning",
          message: "A harmless warning",
          path: "main.typ",
          line: 3,
          column: 1
        }]
      };
    });
    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    expect(read.outcome).toBe("success");
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    const baseSnapshot = read.result.snapshot_id;
    if (typeof baseSnapshot !== "string") return;

    const response = await port.execute({
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: baseSnapshot,
        patch: [
          "--- a/main.typ",
          "+++ b/main.typ",
          "@@ -1,99 +42,77 @@",
          " #set document(title: [Current title])",
          "-Alice Example",
          "+Alice Author",
          "+#let author = [Alice Author]",
          " Current body"
        ].join("\n")
      }
    });

    expect(reviewed).toMatchObject({
      editKind: "patch",
      path: "main.typ",
      baseSnapshot,
      candidateText:
        "#set document(title: [Current title])\nAlice Author\n#let author = [Alice Author]\nCurrent body",
      patch: [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,3 +1,4 @@",
        " #set document(title: [Current title])",
        "-Alice Example",
        "+Alice Author",
        "+#let author = [Alice Author]",
        " Current body"
      ].join("\n"),
      addedLines: 2,
      removedLines: 1,
      hunkCount: 1
    });
    expect(events).toEqual(["compile", "review"]);
    expect(response).toMatchObject({
      outcome: "success",
      result: {
        path: "main.typ",
        base_snapshot: baseSnapshot,
        status: "review_pending",
        review_id: "review-patch",
        verification: {
          status: "passed",
          diagnostics: [{
            severity: "warning",
            message: "A harmless warning",
            path: "main.typ",
            line: 3,
            column: 1
          }]
        }
      }
    });
  });

  it("replaces a fully read file through the shared compile and review pipeline", async () => {
    const events: string[] = [];
    let reviewed: Omit<AssistantEditProposal, "id"> | null = null;
    const port = portFor(source, (proposal) => {
      events.push("review");
      reviewed = proposal;
      return { outcome: "pending", reviewId: "review-write" };
    }, true, async ({ candidateText }) => {
      events.push("compile");
      expect(candidateText).toContain("Alice Author");
      return {
        outcome: "completed",
        revision: compileRevision,
        errors: [],
        diagnostics: []
      };
    });
    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    if (typeof read.result.snapshot_id !== "string") return;

    const response = await port.execute({
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: read.result.snapshot_id,
        content: [
          "#set document(title: [Current title])",
          "Alice Author",
          "Current body"
        ].join("\n")
      }
    });

    expect(events).toEqual(["compile", "review"]);
    expect(reviewed).toMatchObject({
      editKind: "full-file",
      path: "main.typ",
      baseSnapshot: read.result.snapshot_id,
      candidateText:
        "#set document(title: [Current title])\nAlice Author\nCurrent body",
      addedLines: 1,
      removedLines: 1,
      hunkCount: 1
    });
    expect((reviewed as Omit<AssistantEditProposal, "id"> | null)?.patch).toContain(
      "-Alice Example\n+Alice Author"
    );
    expect(response).toMatchObject({
      outcome: "success",
      result: {
        status: "review_pending",
        review_id: "review-write",
        verification: { status: "passed" }
      }
    });
  });

  it("requires a complete untruncated read before a full-file replacement", async () => {
    const port = portFor(source);
    const partialRead = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ", start_line: 1, end_line: 2 }
    });
    if (partialRead.outcome !== "success" || !("snapshot_id" in partialRead.result)) return;
    if (typeof partialRead.result.snapshot_id !== "string") return;

    await expect(port.execute({
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: partialRead.result.snapshot_id,
        content: "#set document(title: [Current title])\nAlice Author\nCurrent body"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_full_read_required" }
    });
  });

  it("preserves an existing final newline in full-file content", async () => {
    const current = source();
    current.activeDocument = {
      path: "main.typ",
      text: "#set document(title: [Current title])\nAlice Example\nCurrent body\n"
    };
    let candidate = "";
    const port = portFor(() => current, (proposal) => {
      candidate = proposal.candidateText;
      return { outcome: "pending", reviewId: "review-newline" };
    });
    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    if (typeof read.result.snapshot_id !== "string") return;
    await port.execute({
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: read.result.snapshot_id,
        content: "#set document(title: [Current title])\nAlice Author\nCurrent body"
      }
    });
    expect(candidate).toBe(
      "#set document(title: [Current title])\nAlice Author\nCurrent body\n"
    );
  });

  it("allows a full-file replacement to produce an empty file", async () => {
    let candidate = "not-reviewed";
    const port = portFor(source, (proposal) => {
      candidate = proposal.candidateText;
      return { outcome: "pending", reviewId: "review-empty" };
    });
    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    if (typeof read.result.snapshot_id !== "string") return;

    const response = await port.execute({
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: read.result.snapshot_id,
        content: ""
      }
    });

    expect(candidate).toBe("");
    expect(response).toMatchObject({
      outcome: "success",
      result: { status: "review_pending", review_id: "review-empty" }
    });
  });

  it("returns candidate diagnostics to the agent without opening review", async () => {
    let reviews = 0;
    const port = portFor(source, () => {
      reviews += 1;
      return { outcome: "pending", reviewId: "review-unexpected" };
    }, true, async () => ({
      outcome: "completed",
      revision: compileRevision,
      errors: ["main.typ:2: unexpected token"],
      diagnostics: [{
        severity: "error",
        message: "unexpected token",
        path: "main.typ",
        line: 2,
        column: 1
      }]
    }));
    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    if (typeof read.result.snapshot_id !== "string") return;

    const response = await port.execute({
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: read.result.snapshot_id,
        patch: [
          "--- a/main.typ",
          "+++ b/main.typ",
          "@@ -1,3 +1,3 @@",
          " #set document(title: [Current title])",
          "-Alice Example",
          "+#broken(",
          " Current body"
        ].join("\n")
      }
    });

    expect(reviews).toBe(0);
    expect(response).toMatchObject({
      outcome: "success",
      result: {
        status: "compile_failed",
        verification: {
          status: "failed",
          errors: ["main.typ:2: unexpected token"],
          diagnostics: [{
            severity: "error",
            message: "unexpected token",
            path: "main.typ",
            line: 2,
            column: 1
          }]
        }
      }
    });
  });

  it("rejects stale, malformed, inactive and unavailable write requests", async () => {
    const port = portFor(source);
    await expect(port.execute({
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: "sha256-stale",
        patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1,2 +1,2 @@\n context\n-old\n+new"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_snapshot_stale" }
    });

    const read = await port.execute({
      tool: "read_project_file",
      arguments: { path: "main.typ" }
    });
    if (read.outcome !== "success" || !("snapshot_id" in read.result)) return;
    const baseSnapshot = read.result.snapshot_id;
    if (typeof baseSnapshot !== "string") return;
    await expect(port.execute({
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: baseSnapshot,
        patch: "--- a/main.typ\n+++ b/main.typ\n@@ -2 +2 @@\n-Alice Example\n+Alice Author"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_patch_invalid" }
    });
    await expect(port.execute({
      tool: "apply_patch",
      arguments: {
        path: "chapters/intro.typ",
        base_snapshot: baseSnapshot,
        patch: "--- a/chapters/intro.typ\n+++ b/chapters/intro.typ\n@@ -1,2 +1,2 @@\n = Introduction\n-Community text\n+New text"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_document_not_active" }
    });

    const readOnlyPort = portFor(
      source,
      () => ({ outcome: "pending", reviewId: "review-read-only" }),
      false
    );
    expect(readOnlyPort.capabilities.tools).not.toContain("apply_patch");
    expect(readOnlyPort.capabilities.tools).not.toContain("write_file");
    await expect(readOnlyPort.execute({
      tool: "apply_patch",
      arguments: {
        path: "main.typ",
        base_snapshot: baseSnapshot,
        patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1,2 +1,2 @@\n context\n-old\n+new"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_tool_not_available" }
    });
    await expect(readOnlyPort.execute({
      tool: "write_file",
      arguments: {
        path: "main.typ",
        base_snapshot: baseSnapshot,
        content: "replacement"
      }
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_tool_not_available" }
    });
  });
});
