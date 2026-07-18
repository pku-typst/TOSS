// @vitest-environment node

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCollaborationBackend } from "@/browserBackend/browserCollaborationBackend";
import { BrowserWorkspaceEvents } from "@/browserBackend/browserEvents";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser collaboration backend", () => {
  it("persists local Yjs edits without invalidating the document session", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const workspaceEvents = new BrowserWorkspaceEvents();
    const store = new BrowserWorkspaceStore(workspaceEvents);
    const project = await store.createSeededProject("Collaboration project", {
      projectType: "typst",
      latexEngine: null,
      entryFilePath: "main.typ",
      files: [{ path: "main.typ", content: "= Hello" }],
    });
    const bootstrap = await store.loadBootstrap({
      projectId: project.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    const identity = bootstrap.documentIdentities["main.typ"];
    if (!identity) throw new Error("test_document_missing");

    let ready: ((content: string) => void) | null = null;
    const readyContent = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const onDocumentChanged = vi.fn();
    const onSaved = vi.fn();
    const backend = createBrowserCollaborationBackend(store);
    const session = backend.openDocument({
      sessionKey: "test-session",
      projectId: project.id,
      documentId: identity.id,
      collaborationRevision: identity.collaborationRevision,
      userId: "browser-user",
      userName: "Browser User",
      shareToken: null,
      guestSession: null,
      canWrite: true,
    }, {
      onPresenceChange: vi.fn(),
      onStatusChange: vi.fn(),
      onReconnectChange: vi.fn(),
      onReady: (content) => ready?.(content),
      onSaved,
      onDocumentChanged,
      onProjectReplaced: vi.fn(),
      onAccessChanged: vi.fn(),
    });

    await expect(readyContent).resolves.toBe("= Hello");
    session.ytext.insert(session.ytext.length, "!");
    await expect(session.commands.sendSyncSnapshot()).resolves.toBe(true);

    const persisted = await store.loadBootstrap({
      projectId: project.id,
      projectTypeHint: "typst",
      canWrite: true,
    });
    expect(persisted.documents["main.typ"]).toBe("= Hello!");
    expect(onSaved).toHaveBeenCalledWith("= Hello!");
    expect(onDocumentChanged).not.toHaveBeenCalled();

    session.close();
    workspaceEvents.close();
  });
});
