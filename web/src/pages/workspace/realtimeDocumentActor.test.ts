import { createActor } from "xstate";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  openRealtimeDocumentSession,
  realtimeDocumentMachine,
  type OpenRealtimeDocumentSession,
  type RealtimeDocumentConfig,
  type RealtimeDocumentSessionEvents,
} from "@/pages/workspace/realtimeDocumentActor";

const indexeddbPersistence = vi.hoisted(() => vi.fn());

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: indexeddbPersistence,
}));

class BootstrapWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: BootstrapWebSocket[] = [];

  readyState = BootstrapWebSocket.CONNECTING;

  constructor(_url: string) {
    super();
    BootstrapWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = BootstrapWebSocket.CLOSED;
  }

  open() {
    this.readyState = BootstrapWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  finishBootstrap() {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          doc_id: "document-a:0",
          user_id: "system",
          is_current_connection: false,
          kind: "bootstrap.done",
          payload: {},
          at: "2026-07-12T00:00:00Z",
        }),
      }),
    );
  }
}

afterEach(() => {
  BootstrapWebSocket.instances = [];
  indexeddbPersistence.mockClear();
  vi.unstubAllGlobals();
});

function config(path: string): RealtimeDocumentConfig {
  return {
    sessionKey: `project-a:${path}:writer`,
    projectId: "project-a",
    documentId: `document:${path}`,
    collaborationRevision: 0,
    userId: "user-a",
    userName: "Ada",
    shareToken: null,
    guestSession: null,
    canWrite: true,
  };
}

function fakeSessionFactory() {
  const opened: Array<{
    config: RealtimeDocumentConfig;
    events: RealtimeDocumentSessionEvents;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const openSession: OpenRealtimeDocumentSession = (nextConfig, events) => {
    const ydoc = new Y.Doc();
    const close = vi.fn(() => ydoc.destroy());
    opened.push({ config: nextConfig, events, close });
    return {
      ydoc,
      ytext: ydoc.getText("main"),
      commands: {
        sendCursor: vi.fn(),
        reconnectNow: vi.fn(),
        sendSyncSnapshot: vi.fn(async () => true),
      },
      close,
    };
  };
  return { openSession, opened };
}

describe("realtimeDocumentMachine", () => {
  it("scopes writable local recovery to the member and collaboration identity", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      clearInterval: globalThis.clearInterval,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      setTimeout: globalThis.setTimeout,
    });
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("WebSocket", BootstrapWebSocket);

    const session = openRealtimeDocumentSession(config("main.typ"), {
      onPresenceChange: vi.fn(),
      onStatusChange: vi.fn(),
      onReconnectChange: vi.fn(),
      onReady: vi.fn(),
      onSaved: vi.fn(),
      onDocumentChanged: vi.fn(),
      onProjectReplaced: vi.fn(),
      onAccessChanged: vi.fn(),
    });

    expect(indexeddbPersistence).toHaveBeenCalledWith(
      "typst-collab:user-a:project-a:document:main.typ:0",
      session.ydoc,
    );
    session.close();
  });

  it("does not synthesize client-side Yjs state at bootstrap", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      clearInterval: globalThis.clearInterval,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      setTimeout: globalThis.setTimeout,
    });
    vi.stubGlobal("WebSocket", BootstrapWebSocket);
    const ready = vi.fn();
    const session = openRealtimeDocumentSession(config("main.typ"), {
      onPresenceChange: vi.fn(),
      onStatusChange: vi.fn(),
      onReconnectChange: vi.fn(),
      onReady: ready,
      onSaved: vi.fn(),
      onDocumentChanged: vi.fn(),
      onProjectReplaced: vi.fn(),
      onAccessChanged: vi.fn(),
    });
    const socket = BootstrapWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.open();
    socket?.finishBootstrap();

    expect(ready).toHaveBeenCalledWith("");
    expect(session.ytext.toString()).toBe("");
    session.close();
  });

  it("owns bootstrap and connection state for one document binding", () => {
    const { openSession, opened } = fakeSessionFactory();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced: vi.fn(),
        onAccessChanged: vi.fn(),
      },
    }).start();

    actor.send({ type: "bind", config: config("main.typ") });
    expect(opened).toHaveLength(1);
    expect(
      actor.getSnapshot().matches({
        active: { document: "bootstrapping", connection: "connecting" },
      }),
    ).toBe(true);

    opened[0]?.events.onPresenceChange([
      {
        connectionId: "connection-a",
        userId: "user-a",
        userName: "Ada",
        canWrite: true,
        isCurrentConnection: true,
      },
    ]);
    opened[0]?.events.onStatusChange("connected");
    opened[0]?.events.onReady("ready content");

    expect(
      actor.getSnapshot().matches({
        active: { document: "ready", connection: "connected" },
      }),
    ).toBe(true);
    expect(actor.getSnapshot().context.readyContent).toBe("ready content");
    expect(actor.getSnapshot().context.presence).toEqual([
      {
        connectionId: "connection-a",
        userId: "user-a",
        userName: "Ada",
        canWrite: true,
        isCurrentConnection: true,
      },
    ]);
    actor.stop();
    expect(opened[0]?.close).toHaveBeenCalledOnce();
  });

  it("keeps the current binding for equivalent configuration", () => {
    const { openSession, opened } = fakeSessionFactory();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced: vi.fn(),
        onAccessChanged: vi.fn(),
      },
    }).start();
    const initial = config("main.typ");

    actor.send({ type: "bind", config: initial });
    actor.send({
      type: "bind",
      config: { ...initial },
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.close).not.toHaveBeenCalled();
    actor.stop();
  });

  it("closes the old resource and ignores its late events when the path changes", () => {
    const { openSession, opened } = fakeSessionFactory();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced: vi.fn(),
        onAccessChanged: vi.fn(),
      },
    }).start();

    actor.send({ type: "bind", config: config("one.typ") });
    const firstEvents = opened[0]?.events;
    actor.send({ type: "bind", config: config("two.typ") });

    expect(opened).toHaveLength(2);
    expect(opened[0]?.close).toHaveBeenCalledOnce();
    firstEvents?.onStatusChange("connected");
    firstEvents?.onReady("stale");
    expect(
      actor.getSnapshot().matches({
        active: { document: "bootstrapping", connection: "connecting" },
      }),
    ).toBe(true);
    expect(actor.getSnapshot().context.readyContent).toBeNull();

    actor.send({ type: "disable" });
    expect(actor.getSnapshot().matches("inactive")).toBe(true);
    expect(opened[1]?.close).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.session).toBeNull();
    actor.stop();
  });

  it("terminates the binding before handling project replacement", () => {
    const { openSession, opened } = fakeSessionFactory();
    const onProjectReplaced = vi.fn();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced,
        onAccessChanged: vi.fn(),
      },
    }).start();

    actor.send({ type: "bind", config: config("main.typ") });
    opened[0]?.events.onProjectReplaced();

    expect(actor.getSnapshot().matches("replaced")).toBe(true);
    expect(opened[0]?.close).toHaveBeenCalledOnce();
    expect(onProjectReplaced).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("waits for a new collaboration identity after the document is superseded", () => {
    const { openSession, opened } = fakeSessionFactory();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced: vi.fn(),
        onAccessChanged: vi.fn(),
      },
    }).start();

    const initial = config("main.typ");
    actor.send({ type: "bind", config: initial });
    opened[0]?.events.onDocumentChanged();

    expect(actor.getSnapshot().matches("superseded")).toBe(true);
    expect(opened[0]?.close).toHaveBeenCalledOnce();

    actor.send({
      type: "bind",
      config: { ...initial, collaborationRevision: 1, sessionKey: "revision-1" },
    });
    expect(actor.getSnapshot().matches("active")).toBe(true);
    expect(opened).toHaveLength(2);
    actor.stop();
  });

  it("closes the document binding before invalidating cached authorization", () => {
    const { openSession, opened } = fakeSessionFactory();
    const onAccessChanged = vi.fn();
    const actor = createActor(realtimeDocumentMachine, {
      input: {
        openSession,
        onProjectReplaced: vi.fn(),
        onAccessChanged,
      },
    }).start();

    actor.send({ type: "bind", config: config("main.typ") });
    opened[0]?.events.onAccessChanged();

    expect(actor.getSnapshot().matches("accessInvalidated")).toBe(true);
    expect(opened[0]?.close).toHaveBeenCalledOnce();
    expect(onAccessChanged).toHaveBeenCalledOnce();
    actor.stop();
  });
});
