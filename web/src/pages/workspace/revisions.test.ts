import { describe, expect, it } from "vitest";
import type { RevisionTransfer } from "@/lib/api";
import { applyRevisionTransfer } from "@/pages/workspace/revisions";

function response(overrides: Partial<RevisionTransfer> = {}): RevisionTransfer {
  return {
    revision_id: "target",
    entry_file_path: "main.typ",
    transfer_mode: "full",
    base_anchor: "none",
    base_revision_id: null,
    nodes: [{ path: "main.typ", kind: "file" }],
    documents: [{ path: "main.typ", content: "= target" }],
    deleted_documents: [],
    assets: [],
    deleted_assets: [],
    ...overrides
  };
}

const emptyInput = {
  currentRevisionAnchorId: null,
  liveDocs: {},
  liveAssets: {},
  liveAssetMeta: {},
  revisionDocs: {},
  revisionAssets: {},
  revisionAssetMeta: {}
};

describe("applyRevisionTransfer", () => {
  it("replaces the workspace for a full transfer", () => {
    const result = applyRevisionTransfer({
      ...emptyInput,
      response: response({
        entry_file_path: "slides.typ",
        nodes: [{ path: "slides.typ", kind: "file" }],
        documents: [{ path: "slides.typ", content: "= slides" }],
        assets: [
          {
            path: "logo.png",
            content_type: "image/png",
            size_bytes: 3,
            content_base64: "AQID"
          }
        ]
      }),
      liveDocs: { "stale.typ": "stale" },
      liveAssets: { "stale.png": "AAAA" },
      liveAssetMeta: { "stale.png": { contentType: "image/png" } }
    });

    expect(result.applied).toBe(true);
    expect(result.docs).toEqual({ "slides.typ": "= slides" });
    expect(result.assets).toEqual({ "logo.png": "AQID" });
    expect(result.assetMeta).toEqual({ "logo.png": { contentType: "image/png" } });
    expect(result.entryFilePath).toBe("slides.typ");
  });

  it("applies live-anchored additions and deletions", () => {
    const result = applyRevisionTransfer({
      ...emptyInput,
      response: response({
        transfer_mode: "delta",
        base_anchor: "live",
        documents: [{ path: "main.typ", content: "= historical" }],
        deleted_documents: ["notes.typ"],
        assets: [],
        deleted_assets: ["old.png"]
      }),
      liveDocs: { "main.typ": "= live", "notes.typ": "notes" },
      liveAssets: { "old.png": "AAAA", "keep.png": "BBBB" },
      liveAssetMeta: {
        "old.png": { contentType: "image/png" },
        "keep.png": { contentType: "image/png" }
      }
    });

    expect(result.applied).toBe(true);
    expect(result.docs).toEqual({ "main.typ": "= historical" });
    expect(result.assets).toEqual({ "keep.png": "BBBB" });
  });

  it("uses the current revision only when the anchor matches", () => {
    const matching = applyRevisionTransfer({
      ...emptyInput,
      response: response({
        transfer_mode: "delta",
        base_anchor: "revision",
        base_revision_id: "base",
        documents: [{ path: "added.typ", content: "added" }]
      }),
      currentRevisionAnchorId: "base",
      revisionDocs: { "main.typ": "= base" }
    });
    expect(matching.applied).toBe(true);
    expect(matching.docs).toEqual({ "main.typ": "= base", "added.typ": "added" });

    const mismatching = applyRevisionTransfer({
      ...emptyInput,
      response: response({
        transfer_mode: "delta",
        base_anchor: "revision",
        base_revision_id: "different"
      }),
      currentRevisionAnchorId: "base"
    });
    expect(mismatching.applied).toBe(false);
  });

  it("can force a malformed delta response through the full-transfer path", () => {
    const result = applyRevisionTransfer({
      ...emptyInput,
      forceFull: true,
      response: response({
        transfer_mode: "delta",
        base_anchor: "revision",
        base_revision_id: "missing"
      })
    });
    expect(result.applied).toBe(true);
    expect(result.docs).toEqual({ "main.typ": "= target" });
  });
});
