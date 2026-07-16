import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectSettings,
  getProjectTree,
  listDocuments,
  listProjectAssets,
  type Document
} from "@/lib/api";
import { loadWorkspaceDelta } from "@/pages/workspace/loaders";

vi.mock("@/lib/api", () => ({
  createProjectFile: vi.fn(),
  getGitRepoLink: vi.fn(),
  getProjectSettings: vi.fn(),
  getProjectTree: vi.fn(),
  listDocuments: vi.fn(),
  listProjectAssets: vi.fn(),
  listProjectShareLinks: vi.fn()
}));

function document(id: string, path: string, changeSequence: number): Document {
  return {
    id,
    project_id: "project-a",
    path,
    path_revision: 0,
    collaboration_revision: 0,
    change_sequence: changeSequence,
    content: `content:${path}`,
    updated_at: "2026-07-12T00:00:00Z"
  };
}

beforeEach(() => {
  vi.mocked(getProjectTree).mockReset().mockResolvedValue({
    nodes: [
      { path: "one.typ", kind: "file" },
      { path: "two.typ", kind: "file" }
    ],
    entry_file_path: "one.typ",
    content_epoch: 0
  });
  vi.mocked(getProjectSettings).mockReset().mockResolvedValue({
    project_id: "project-a",
    project_type: "typst",
    latex_engine: null,
    entry_file_path: "one.typ",
    settings_revision: 0,
    updated_at: "2026-07-12T00:00:00Z"
  });
  vi.mocked(listProjectAssets).mockReset().mockResolvedValue({ assets: [] });
  vi.mocked(listDocuments).mockReset();
});

describe("workspace delta loading", () => {
  it("drains every document page before advancing the change cursor", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({
        documents: [document("document-one", "one.typ", 10)],
        cursor: 10,
        has_more: true
      })
      .mockResolvedValueOnce({
        documents: [document("document-two", "two.typ", 11)],
        cursor: 11,
        has_more: false
      });

    const delta = await loadWorkspaceDelta({
      projectId: "project-a",
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "one.typ",
      afterDocumentsChangeSequence: 9
    });

    expect(listDocuments).toHaveBeenNthCalledWith(1, "project-a", {
      afterChangeSequence: 9
    });
    expect(listDocuments).toHaveBeenNthCalledWith(2, "project-a", {
      afterChangeSequence: 10
    });
    expect(delta.documents).toEqual({
      "one.typ": "content:one.typ",
      "two.typ": "content:two.typ"
    });
    expect(delta.documentsChangeSequence).toBe(11);
  });

  it("fails the delta when settings cannot be refreshed", async () => {
    vi.mocked(getProjectSettings).mockRejectedValue(new Error("offline"));
    vi.mocked(listDocuments).mockResolvedValue({
      documents: [],
      cursor: null,
      has_more: false
    });

    await expect(
      loadWorkspaceDelta({
        projectId: "project-a",
        projectType: "typst",
        latexEngine: "xetex",
        entryFilePath: "one.typ",
        afterDocumentsChangeSequence: null
      })
    ).rejects.toThrow("offline");
  });
});
