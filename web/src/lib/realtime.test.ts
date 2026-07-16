import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeServerEvent } from "@/lib/api/types";
import { base64ToBytes } from "@/lib/base64";
import { bindRealtimeYDoc, type PresenceSession } from "@/lib/realtime";

function serverEvent(
  kind: RealtimeServerEvent["kind"],
  userId: string,
  payload: unknown,
  connectionId?: string,
  isCurrentConnection = false,
): RealtimeServerEvent {
  return {
    doc_id: "project:main.typ",
    user_id: userId,
    connection_id: connectionId,
    is_current_connection: isCurrentConnection,
    kind,
    payload,
    at: "2026-07-10T00:00:00Z",
  };
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  disconnect() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("realtime presence", () => {
  it("publishes the local participant before the socket connects", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const snapshots: PresenceSession[][] = [];

    const binding = bindRealtimeYDoc({
      docId: "project:main.typ",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "self",
      userName: "Ada",
      onPresenceChange: (users) => snapshots.push(users),
    });

    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: expect.stringMatching(/^local:client-/),
        userId: "self",
        userName: "Ada",
        canWrite: true,
        isCurrentConnection: true,
      },
    ]);

    binding.close();
    ydoc.destroy();
  });

  it("publishes a complete Yjs snapshot after every reconnect bootstrap", async () => {
    const reconnectDelaySeconds = 1;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const binding = bindRealtimeYDoc({
      docId: "0198fd33-a782-7e62-b56c-cc894e583c4d",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "owner",
      userName: "Owner",
      reconnectDelaySeconds,
    });
    const first = FakeWebSocket.instances[0];
    expect(first).toBeDefined();
    first.open();
    first.receive(serverEvent("bootstrap.done", "system", {}));
    first.disconnect();

    ydoc.getText("main").insert(0, "offline edit");
    await vi.advanceTimersByTimeAsync(reconnectDelaySeconds * 1000);
    const second = FakeWebSocket.instances[1];
    expect(second).toBeDefined();
    second.open();
    second.receive(serverEvent("bootstrap.done", "system", {}));

    const syncMessage = second.sent
      .map(
        (message) => JSON.parse(message) as { kind: string; payload?: string },
      )
      .filter((message) => message.kind === "yjs.sync")
      .at(-1);
    expect(syncMessage?.payload).toBeTypeOf("string");
    const restored = new Y.Doc();
    if (syncMessage?.payload) {
      Y.applyUpdate(restored, base64ToBytes(syncMessage.payload));
    }
    expect(restored.getText("main").toString()).toBe("offline edit");

    restored.destroy();
    binding.close();
    ydoc.destroy();
    vi.useRealTimers();
  });

  it("keeps read-only participants and answers joins with local metadata", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const snapshots: PresenceSession[][] = [];
    const binding = bindRealtimeYDoc({
      docId: "project:main.typ",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "owner",
      userName: "Owner",
      onPresenceChange: (users) => snapshots.push(users),
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();
    expect(socket.sent.map((message) => JSON.parse(message).kind)).toEqual([
      "presence.meta",
    ]);

    socket.receive(
      serverEvent(
        "presence.join",
        "viewer",
        { user_name: "Viewer", can_write: false },
        "viewer-tab",
      ),
    );

    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: expect.stringMatching(/^local:client-/),
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: true,
      },
      {
        connectionId: "viewer-tab",
        userId: "viewer",
        userName: "Viewer",
        canWrite: false,
        isCurrentConnection: false,
      },
    ]);
    expect(socket.sent.map((message) => JSON.parse(message).kind)).toEqual([
      "presence.meta",
      "presence.meta",
    ]);

    binding.close();
    ydoc.destroy();
  });

  it("keeps a member present while another tab for that member remains connected", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const snapshots: PresenceSession[][] = [];
    const binding = bindRealtimeYDoc({
      docId: "project:main.typ",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "owner",
      userName: "Owner",
      onPresenceChange: (users) => snapshots.push(users),
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    socket.receive(
      serverEvent(
        "presence.join",
        "viewer",
        { user_name: "Viewer", can_write: true },
        "viewer-tab-a",
      ),
    );
    socket.receive(
      serverEvent(
        "presence.join",
        "viewer",
        { user_name: "Viewer", can_write: true },
        "viewer-tab-b",
      ),
    );
    socket.receive(
      serverEvent("presence.leave", "viewer", {}, "viewer-tab-a"),
    );

    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: expect.stringMatching(/^local:client-/),
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: true,
      },
      {
        connectionId: "viewer-tab-b",
        userId: "viewer",
        userName: "Viewer",
        canWrite: true,
        isCurrentConnection: false,
      },
    ]);

    socket.receive(
      serverEvent("presence.leave", "viewer", {}, "viewer-tab-b"),
    );
    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: expect.stringMatching(/^local:client-/),
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: true,
      },
    ]);

    binding.close();
    ydoc.destroy();
  });

  it("keeps current and remote sessions for the same member distinct", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const snapshots: PresenceSession[][] = [];
    const binding = bindRealtimeYDoc({
      docId: "project:main.typ",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "owner",
      userName: "Owner",
      onPresenceChange: (users) => snapshots.push(users),
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    socket.receive(
      serverEvent(
        "presence.join",
        "owner",
        { user_name: "Owner", can_write: true },
        "owner-tab-a",
        true,
      ),
    );
    socket.receive(
      serverEvent(
        "presence.meta",
        "owner",
        { user_name: "Owner", can_write: true },
        "owner-tab-b",
      ),
    );
    socket.receive(
      serverEvent(
        "presence.cursor",
        "owner",
        {
          user_name: "Owner",
          can_write: true,
          line: 3,
          column: 7,
        },
        "owner-tab-b",
      ),
    );

    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: "owner-tab-a",
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: true,
      },
      {
        connectionId: "owner-tab-b",
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: false,
        line: 3,
        column: 7,
      },
    ]);
    expect(
      socket.sent
        .map((message) => JSON.parse(message) as { kind: string })
        .filter((message) => message.kind === "presence.meta"),
    ).toHaveLength(2);

    socket.receive(
      serverEvent("presence.leave", "owner", {}, "owner-tab-b"),
    );
    expect(snapshots.at(-1)).toEqual([
      {
        connectionId: "owner-tab-a",
        userId: "owner",
        userName: "Owner",
        canWrite: true,
        isCurrentConnection: true,
      },
    ]);

    binding.close();
    ydoc.destroy();
  });

  it("invalidates an editor when the project snapshot is replaced", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const onProjectReplaced = vi.fn();
    const binding = bindRealtimeYDoc({
      docId: "project:main.typ",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      userId: "owner",
      userName: "Owner",
      onProjectReplaced,
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.open();

    socket.receive({
      kind: "project.replaced",
      user_id: "system",
      payload: { content_epoch: 2 },
    });
    expect(onProjectReplaced).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    socket.receive(
      serverEvent("project.replaced", "system", { content_epoch: 2 }),
    );

    expect(onProjectReplaced).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    binding.close();
    ydoc.destroy();
  });

  it("stops a superseded document binding instead of reconnecting its stale identity", async () => {
    const reconnectDelaySeconds = 1;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const onDocumentChanged = vi.fn();
    const binding = bindRealtimeYDoc({
      docId: "0198fd33-a782-7e62-b56c-cc894e583c4d",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      reconnectDelaySeconds,
      onDocumentChanged,
    });
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive(serverEvent("document.changed", "system", {}));

    expect(onDocumentChanged).toHaveBeenCalledOnce();
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(reconnectDelaySeconds * 1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    binding.close();
    ydoc.destroy();
    vi.useRealTimers();
  });

  it("invalidates the editor authorization without reconnecting as a stale writer", async () => {
    const reconnectDelaySeconds = 1;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const ydoc = new Y.Doc();
    const onAccessChanged = vi.fn();
    const binding = bindRealtimeYDoc({
      docId: "0198fd33-a782-7e62-b56c-cc894e583c4d",
      collaborationRevision: 0,
      projectId: "project",
      wsBaseUrl: "http://localhost",
      ydoc,
      reconnectDelaySeconds,
      onAccessChanged,
    });
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive(serverEvent("access.changed", "system", {}));

    expect(onAccessChanged).toHaveBeenCalledOnce();
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(reconnectDelaySeconds * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    binding.close();
    ydoc.destroy();
    vi.useRealTimers();
  });
});
