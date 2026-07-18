// @vitest-environment node

import "fake-indexeddb/auto";
import { parseTarGzip } from "nanotar";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BrowserWorkspaceEvents } from "@/browserBackend/browserEvents";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";

function createStore() {
  const events = new BrowserWorkspaceEvents();
  return { events, store: new BrowserWorkspaceStore(events) };
}

function typstSeed(content = "= Hello") {
  return {
    projectType: "typst" as const,
    latexEngine: null,
    entryFilePath: "main.typ",
    files: [{ path: "main.typ", content }],
  };
}

const openedEvents: BrowserWorkspaceEvents[] = [];

afterEach(() => {
  for (const events of openedEvents.splice(0)) events.close();
});

describe("BrowserWorkspaceStore", () => {
  it("persists projects, structural changes, assets, and portable archives", async () => {
    const { events, store } = createStore();
    openedEvents.push(events);
    const project = await store.createSeededProject("Browser project", typstSeed());

    await store.createFile(project.id, {
      kind: "file",
      path: "chapters/intro.typ",
      content: "= Intro",
    });
    await store.uploadAsset(project.id, {
      path: "images/pixel.bin",
      content_base64: "AQID",
      content_type: "application/octet-stream",
    });
    await store.movePath(project.id, {
      from_path: "chapters/intro.typ",
      to_path: "chapters/opening.typ",
    });

    const workspace = await store.loadBootstrap({
      projectId: project.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    expect(workspace.documents).toEqual({
      "main.typ": "= Hello",
      "chapters/opening.typ": "= Intro",
    });
    expect(workspace.nodes).toContainEqual({
      kind: "file",
      path: "images/pixel.bin",
    });

    const archive = await parseTarGzip(
      new Uint8Array(await (await store.downloadArchive(project.id)).arrayBuffer()),
    );
    expect(archive.map((file) => file.name).sort()).toEqual([
      "chapters/opening.typ",
      "images/pixel.bin",
      "main.typ",
    ]);
  });

  it("serializes concurrent IndexedDB writes and merges Yjs updates", async () => {
    const { events, store } = createStore();
    openedEvents.push(events);
    const project = await store.createSeededProject("Concurrent project", typstSeed("A"));
    const initial = await store.loadBootstrap({
      projectId: project.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    const identity = initial.documentIdentities["main.typ"];
    expect(identity).toBeDefined();
    const state = await store.loadDocumentState(project.id, identity!.id);

    const first = new Y.Doc();
    Y.applyUpdate(first, state.update);
    const firstVector = Y.encodeStateVector(first);
    first.getText("main").insert(1, "1");
    const firstUpdate = Y.encodeStateAsUpdate(first, firstVector);

    const second = new Y.Doc();
    Y.applyUpdate(second, state.update);
    const secondVector = Y.encodeStateVector(second);
    second.getText("main").insert(0, "2");
    const secondUpdate = Y.encodeStateAsUpdate(second, secondVector);

    await Promise.all([
      store.mergeDocumentUpdate(project.id, identity!.id, firstUpdate),
      store.mergeDocumentUpdate(project.id, identity!.id, secondUpdate),
    ]);
    const updated = await store.loadBootstrap({
      projectId: project.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    expect([...updated.documents["main.typ"]!].sort()).toEqual(["1", "2", "A"]);
    expect(updated.documentsChangeSequence).toBeGreaterThan(
      initial.documentsChangeSequence ?? 0,
    );
  });

  it("keeps copies independent from their source project", async () => {
    const { events, store } = createStore();
    openedEvents.push(events);
    const source = await store.createSeededProject("Source project", typstSeed("source"));
    const copy = await store.copyProject(source.id, "Copy project");
    const copyWorkspace = await store.loadBootstrap({
      projectId: copy.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    await store.upsertText(
      copy.id,
      "main.typ",
      "copy",
      copyWorkspace.contentEpoch,
    );

    const [sourceAfter, copyAfter] = await Promise.all([
      store.loadBootstrap({
        projectId: source.id,
        projectTypeHint: "typst",
        canWrite: true,
      }),
      store.loadBootstrap({
        projectId: copy.id,
        projectTypeHint: "typst",
        canWrite: true,
      }),
    ]);
    expect(sourceAfter.documents["main.typ"]).toBe("source");
    expect(copyAfter.documents["main.typ"]).toBe("copy");
    expect(copyAfter.documentIdentities["main.typ"]?.id).not.toBe(
      sourceAfter.documentIdentities["main.typ"]?.id,
    );
  });

  it("rejects file and directory namespace collisions", async () => {
    const { events, store } = createStore();
    openedEvents.push(events);
    await expect(store.createSeededProject("Invalid seed", {
      ...typstSeed(),
      files: [
        { path: "main.typ", content: "= Main" },
        { path: "main.typ/chapter.typ", content: "= Chapter" },
      ],
    })).rejects.toThrow("project_path_conflict");

    const project = await store.createSeededProject("Valid project", typstSeed());
    await expect(store.createFile(project.id, {
      kind: "file",
      path: "main.typ/chapter.typ",
      content: "= Chapter",
    })).rejects.toThrow("project_path_conflict");
  });
});
