import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeServerEvent } from "@/lib/api/types";
import { bindProjectRealtime } from "@/lib/projectRealtime";
import {
  PROTOCOL_EPOCH,
  PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  protocolCompatibilityState,
  resetProtocolCompatibilityForTest
} from "@/lib/protocolCompatibility";

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

  disconnect(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
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
  resetProtocolCompatibilityForTest();
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
    expect(new URL(first!.url).searchParams.get("protocol_epoch")).toBe(String(PROTOCOL_EPOCH));
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

  it("uses the fast path for a service-restart close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const binding = bindProjectRealtime({
      projectId: "project-a",
      wsBaseUrl: "http://localhost",
    });
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.receive("bootstrap.done", {});
    first?.disconnect(1012);

    await vi.advanceTimersByTimeAsync(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    binding.close();
  });

  it("stops reconnecting when Core rejects the browser protocol", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const binding = bindProjectRealtime({
      projectId: "project-a",
      wsBaseUrl: "http://localhost"
    });

    FakeWebSocket.instances[0]?.disconnect(PROTOCOL_INCOMPATIBLE_CLOSE_CODE);
    await vi.runAllTimersAsync();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(protocolCompatibilityState()).toBe("reload_required");
    binding.close();
  });
});
