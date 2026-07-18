import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import type { CachedProjectSnapshot } from "@/lib/projectCache";
import type {
  WorkspaceBootstrap,
  WorkspaceDelta,
} from "@/pages/workspace/loaders";
import {
  workspaceSessionMachine,
  type WorkspaceSessionScope,
} from "@/pages/workspace/workspaceSessionActor";

function scope(projectId = "project-a", identity = "user-a"): WorkspaceSessionScope {
  return {
    generation: `${identity}\u0000${projectId}`,
    projectId,
    cacheIdentity: "user-a",
    projectTypeHint: "typst",
    latexEngineHint: "xetex",
    defaultEntry: "main.typ",
    unavailable: false,
  };
}

function seed(content: string): CachedProjectSnapshot {
  return {
    cacheIdentity: "user-a",
    projectId: "project-a",
    entryFilePath: "main.typ",
    nodes: [{ path: "main.typ", kind: "file" }],
    docs: { "main.typ": content },
    cachedAt: Date.now(),
  };
}

function bootstrap(content: string, settingsRevision = 0): WorkspaceBootstrap {
  return {
    projectType: "typst",
    latexEngine: "xetex",
    entryFilePath: "main.typ",
    settingsRevision,
    nodes: [
      { path: "main.typ", kind: "file" },
      { path: "notes.typ", kind: "file" },
    ],
    contentEpoch: 4,
    documents: {
      "main.typ": content,
      "notes.typ": "notes",
    },
    documentIdentities: {
      "main.typ": {
        id: "document-main",
        pathRevision: 0,
        collaborationRevision: 1,
      },
      "notes.typ": {
        id: "document-notes",
        pathRevision: 0,
        collaborationRevision: 0,
      },
    },
    documentsChangeSequence: 10,
    assetMeta: {},
  };
}

function delta(contentEpoch = 4, settingsRevision = 0): WorkspaceDelta {
  return {
    projectType: "typst",
    latexEngine: "xetex",
    entryFilePath: "main.typ",
    settingsRevision,
    nodes: [
      { path: "main.typ", kind: "file" },
      { path: "next.typ", kind: "file" },
    ],
    contentEpoch,
    documents: {
      "main.typ": "remote main",
      "next.typ": "next",
    },
    documentIdentities: {
      "main.typ": {
        id: "document-main",
        pathRevision: 0,
        collaborationRevision: 1,
      },
      "next.typ": {
        id: "document-next",
        pathRevision: 0,
        collaborationRevision: 0,
      },
    },
    documentsChangeSequence: 12,
    assetMeta: {},
  };
}

describe("workspaceSessionMachine", () => {
  it("owns cached and server bootstrap projection transitions", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();

    actor.send({
      type: "session.started",
      scope: initialScope,
      seed: seed("cached"),
    });
    expect(actor.getSnapshot().matches({ available: "cached" })).toBe(true);
    expect(actor.getSnapshot().context.documents).toEqual({
      "main.typ": "cached",
    });

    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("server"),
    });
    expect(actor.getSnapshot().context.documents["main.typ"]).toBe("server");
    expect(actor.getSnapshot().context.contentEpoch).toBe(4);
    expect(actor.getSnapshot().matches({ available: "online" })).toBe(true);
  });

  it("rejects bootstrap results from an obsolete project scope", () => {
    const projectA = scope("project-a");
    const projectB = scope("project-b");
    const actor = createActor(workspaceSessionMachine, {
      input: projectA,
    }).start();
    actor.send({ type: "session.started", scope: projectA, seed: null });
    actor.send({ type: "session.started", scope: projectB, seed: null });

    actor.send({
      type: "bootstrap.succeeded",
      generation: projectA.generation,
      bootstrap: bootstrap("obsolete"),
    });

    expect(actor.getSnapshot().matches("loading")).toBe(true);
    expect(actor.getSnapshot().context.scope.projectId).toBe("project-b");
    expect(actor.getSnapshot().context.documents).toEqual({});
  });

  it("merges deltas without overwriting the active dirty Yjs document", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("saved main"),
    });
    actor.send({
      type: "delta.succeeded",
      generation: initialScope.generation,
      delta: delta(),
      activeDocument: {
        path: "main.typ",
        dirty: true,
        text: "local main",
      },
    });

    const projection = actor.getSnapshot().context;
    expect(projection.documents).toEqual({
      "main.typ": "saved main",
      "next.typ": "next",
    });
    expect(projection.documentIdentities).not.toHaveProperty("notes.typ");
    expect(projection.documentsChangeSequence).toBe(12);
  });

  it("enters replaced state when a delta crosses the content epoch", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("saved main"),
    });
    actor.send({
      type: "delta.succeeded",
      generation: initialScope.generation,
      delta: delta(5),
      activeDocument: {
        path: "main.typ",
        dirty: false,
        text: "saved main",
      },
    });

    expect(actor.getSnapshot().matches("replaced")).toBe(true);
    expect(actor.getSnapshot().context.contentEpoch).toBe(4);
  });

  it("applies Workspace projection events only while the session is available", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("saved main"),
    });

    actor.send({
      type: "active-path.selected",
      generation: initialScope.generation,
      path: "notes.typ",
    });
    actor.send({
      type: "document-content.updated",
      generation: initialScope.generation,
      path: "notes.typ",
      content: "updated notes",
    });
    actor.send({
      type: "settings.synchronized",
      generation: initialScope.generation,
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "notes.typ",
      settingsRevision: 1,
    });

    const projection = actor.getSnapshot().context;
    expect(projection.activePath).toBe("notes.typ");
    expect(projection.documents["notes.typ"]).toBe("updated notes");
    expect(projection.latexEngine).toBe("xetex");
    expect(projection.entryFilePath).toBe("notes.typ");
    expect(projection.settingsRevision).toBe(1);
  });

  it("does not let an older delta overwrite confirmed settings", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("saved main", 4),
    });
    actor.send({
      type: "settings.synchronized",
      generation: initialScope.generation,
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "next.typ",
      settingsRevision: 5,
    });
    actor.send({
      type: "delta.succeeded",
      generation: initialScope.generation,
      delta: delta(4, 4),
      activeDocument: {
        path: "main.typ",
        dirty: false,
        text: "saved main",
      },
    });

    const projection = actor.getSnapshot().context;
    expect(projection.entryFilePath).toBe("next.typ");
    expect(projection.settingsRevision).toBe(5);
  });

  it("ignores settings responses that complete out of order", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("saved main", 4),
    });
    actor.send({
      type: "settings.synchronized",
      generation: initialScope.generation,
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "notes.typ",
      settingsRevision: 6,
    });
    actor.send({
      type: "settings.synchronized",
      generation: initialScope.generation,
      projectType: "typst",
      latexEngine: "xetex",
      entryFilePath: "main.typ",
      settingsRevision: 5,
    });

    expect(actor.getSnapshot().context.entryFilePath).toBe("notes.typ");
    expect(actor.getSnapshot().context.settingsRevision).toBe(6);
  });

  it("keeps content replacement terminal until a new session starts", () => {
    const initialScope = scope();
    const actor = createActor(workspaceSessionMachine, {
      input: initialScope,
    }).start();
    actor.send({ type: "session.started", scope: initialScope, seed: null });
    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("server"),
    });
    actor.send({
      type: "delta.succeeded",
      generation: initialScope.generation,
      delta: delta(5),
      activeDocument: {
        path: "main.typ",
        dirty: false,
        text: "server",
      },
    });

    actor.send({
      type: "bootstrap.succeeded",
      generation: initialScope.generation,
      bootstrap: bootstrap("late bootstrap"),
    });
    expect(actor.getSnapshot().matches("replaced")).toBe(true);
    expect(actor.getSnapshot().context.documents["main.typ"]).toBe("server");

    const nextScope = scope("project-a", "user-b");
    actor.send({ type: "session.started", scope: nextScope, seed: null });
    actor.send({
      type: "active-path.selected",
      generation: initialScope.generation,
      path: "stale.typ",
    });
    expect(actor.getSnapshot().matches("loading")).toBe(true);
    expect(actor.getSnapshot().context.scope.generation).toBe(
      nextScope.generation,
    );
    expect(actor.getSnapshot().context.activePath).toBe("main.typ");
  });
});
