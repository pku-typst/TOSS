import type { RealtimeWorkspaceChangedPayload } from "@/lib/api/types";
import {
  parseRealtimeServerEvent,
  parseWorkspaceChangedPayload,
  type RealtimeStatus,
} from "@/lib/realtime";
import { reconnectDelayMs } from "@/lib/reconnectPolicy";
import {
  appendProtocolEpoch,
  isProtocolIncompatibleClose,
  requireProtocolReload,
} from "@/lib/protocolCompatibility";

export type ProjectRealtimeBinding = {
  close: () => void;
};

export function bindProjectRealtime(params: {
  projectId: string;
  wsBaseUrl: string;
  userId?: string;
  sessionToken?: string;
  shareToken?: string;
  guestSession?: string;
  reconnectDelaySeconds?: number;
  onStatusChange?: (status: RealtimeStatus) => void;
  onBootstrapDone?: () => void;
  onWorkspaceChanged?: (change: RealtimeWorkspaceChangedPayload) => void;
  onProjectReplaced?: () => void;
  onAccessChanged?: () => void;
}): ProjectRealtimeBinding {
  const reconnectOverrideSeconds =
    params.reconnectDelaySeconds === undefined
      ? undefined
      : Math.max(1, Math.floor(params.reconnectDelaySeconds));
  const query = new URLSearchParams();
  appendProtocolEpoch(query);
  if (params.userId?.trim()) query.set("user_id", params.userId.trim());
  if (params.sessionToken?.trim()) {
    query.set("session_token", params.sessionToken.trim());
  }
  if (params.shareToken?.trim()) {
    query.set("share_token", params.shareToken.trim());
  }
  if (params.guestSession?.trim()) {
    query.set("guest_session", params.guestSession.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const url = `${params.wsBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/realtime/projects/${encodeURIComponent(params.projectId)}${suffix}`;
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (closeCode?: number) => {
    if (closeCode !== undefined && isProtocolIncompatibleClose(closeCode)) {
      closed = true;
      clearReconnect();
      params.onStatusChange?.("disconnected");
      requireProtocolReload();
      return;
    }
    if (closed || reconnectTimer !== null) return;
    params.onStatusChange?.("disconnected");
    reconnectAttempt += 1;
    const delayMs = reconnectDelayMs({
      attempt: reconnectAttempt,
      closeCode,
      overrideSeconds: reconnectOverrideSeconds,
    });
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = () => {
    if (closed) return;
    clearReconnect();
    params.onStatusChange?.("connecting");
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (closed || socket !== nextSocket) return;
      params.onStatusChange?.("connected");
    });
    nextSocket.addEventListener("message", (event) => {
      if (closed || socket !== nextSocket) return;
      try {
        const parsed = parseRealtimeServerEvent(JSON.parse(String(event.data)));
        if (!parsed) return;
        if (parsed.kind === "bootstrap.done") {
          reconnectAttempt = 0;
          params.onBootstrapDone?.();
          return;
        }
        if (parsed.kind === "workspace.changed") {
          const change = parseWorkspaceChangedPayload(parsed.payload);
          if (change) params.onWorkspaceChanged?.(change);
          return;
        }
        if (parsed.kind === "project.replaced") {
          closed = true;
          clearReconnect();
          nextSocket.close();
          params.onProjectReplaced?.();
          return;
        }
        if (parsed.kind === "access.changed") {
          closed = true;
          clearReconnect();
          nextSocket.close();
          params.onAccessChanged?.();
          return;
        }
        if (parsed.kind === "server.error") {
          nextSocket.close();
          scheduleReconnect();
        }
      } catch {
        // Ignore malformed events; the server will close streams that need resync.
      }
    });
    const handleDisconnect = (closeCode?: number) => {
      if (closed || socket !== nextSocket) return;
      scheduleReconnect(closeCode);
    };
    nextSocket.addEventListener("error", () => {
      if (closed || socket !== nextSocket) return;
      params.onStatusChange?.("disconnected");
    });
    nextSocket.addEventListener("close", (event) =>
      handleDisconnect(event.code),
    );
  };

  connect();
  return {
    close: () => {
      closed = true;
      clearReconnect();
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close();
      }
      socket = null;
      params.onStatusChange?.("disconnected");
    },
  };
}
