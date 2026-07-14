import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeServerEvent } from "@/lib/api/types";
import { bindProjectRealtime } from "@/lib/projectRealtime";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(kind: RealtimeServerEvent["kind"], payload: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          doc_id: "project-a",
          user_id: "system",
          is_current_connection: false,
          kind,
          payload,
          at: "2026-07-12T00:00:00Z",
        }),
      }),
    );
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("project realtime transport", () => {
  it("delivers control events and reconnects after a resync error", async () => {
    const reconnectDelaySeconds = 1;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onBootstrapDone = vi.fn();
    const onWorkspaceChanged = vi.fn();
    const binding = bindProjectRealtime({
      projectId: "project-a",
      wsBaseUrl: "http://localhost",
      userId: "user-a",
      shareToken: "share-a",
      reconnectDelaySeconds,
      onBootstrapDone,
      onWorkspaceChanged,
    });
    const first = FakeWebSocket.instances[0];
    expect(first?.url).toContain("/v1/realtime/projects/project-a");
    expect(first?.url).toContain("share_token=share-a");
    first?.open();
    first?.receive("bootstrap.done", {});
    first?.receive("workspace.changed", {
      scope: "tree",
      path: "slides",
      document_id: null,
      collaboration_revision: null,
      change_sequence: null,
    });
    expect(onBootstrapDone).toHaveBeenCalledOnce();
    expect(onWorkspaceChanged).toHaveBeenCalledWith({
      scope: "tree",
      path: "slides",
      document_id: null,
      collaboration_revision: null,
      change_sequence: null,
    });

    first?.receive("server.error", { resync_required: true });
    await vi.advanceTimersByTimeAsync(reconnectDelaySeconds * 1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    binding.close();
  });

  it("invalidates the authorization context instead of reconnecting with stale permissions", async () => {
    const reconnectDelaySeconds = 1;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onAccessChanged = vi.fn();
    bindProjectRealtime({
      projectId: "project-a",
      wsBaseUrl: "http://localhost",
      reconnectDelaySeconds,
      onAccessChanged,
    });
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive("access.changed", {});

    expect(onAccessChanged).toHaveBeenCalledOnce();
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(reconnectDelaySeconds * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
