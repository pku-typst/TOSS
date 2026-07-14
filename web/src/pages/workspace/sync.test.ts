import { describe, expect, it } from "vitest";
import {
  mergeWorkspaceDocumentDelta,
  retainUnchangedAssetContents
} from "@/pages/workspace/sync";

describe("mergeWorkspaceDocumentDelta", () => {
  it("applies incoming text and removes files missing from the tree", () => {
    const current = {
      "main.typ": "old",
      "deleted.typ": "deleted",
      "image.png": "not a document"
    };

    expect(
      mergeWorkspaceDocumentDelta({
        current,
        incoming: { "main.typ": "new", "notes.typ": "notes" },
        nodes: [
          { path: "main.typ", kind: "file" },
          { path: "notes.typ", kind: "file" }
        ],
        activePath: "main.typ",
        activeDocumentDirty: false,
        activeDocumentText: "old"
      })
    ).toEqual({ "main.typ": "new", "notes.typ": "notes" });
  });

  it("preserves a dirty active document even when remote state deletes it", () => {
    expect(
      mergeWorkspaceDocumentDelta({
        current: { "main.typ": "saved" },
        incoming: { "main.typ": "remote" },
        nodes: [],
        activePath: "main.typ",
        activeDocumentDirty: true,
        activeDocumentText: "local draft"
      })
    ).toEqual({ "main.typ": "local draft" });
  });

  it("preserves identity when there is no effective change", () => {
    const current = { "main.typ": "same" };
    const merged = mergeWorkspaceDocumentDelta({
      current,
      incoming: { "main.typ": "same" },
      nodes: [{ path: "main.typ", kind: "file" }],
      activePath: "main.typ",
      activeDocumentDirty: false,
      activeDocumentText: "same"
    });

    expect(merged).toBe(current);
  });
});

describe("retainUnchangedAssetContents", () => {
  it("keeps only cached assets whose server version is unchanged", () => {
    const unchanged = {
      id: "asset-1",
      contentRevision: "revision-1",
      contentType: "image/png",
      sizeBytes: 10,
      createdAt: "2026-01-01T00:00:00Z"
    };
    const currentContents = { "same.png": "same", "changed.png": "old", "gone.png": "gone" };

    expect(
      retainUnchangedAssetContents(
        currentContents,
        {
          "same.png": unchanged,
          "changed.png": { ...unchanged, id: "asset-2" },
          "gone.png": { ...unchanged, id: "asset-3" }
        },
        {
          "same.png": { ...unchanged },
          "changed.png": { ...unchanged, id: "asset-new" }
        }
      )
    ).toEqual({ "same.png": "same" });
  });
});
