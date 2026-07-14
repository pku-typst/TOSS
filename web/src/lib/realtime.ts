import * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";
import type {
  RealtimeClientMessage,
  RealtimeServerEvent,
  RealtimeWorkspaceChangedPayload,
} from "@/lib/api/types";

export type PresenceSession = {
  connectionId: string;
  userId: string;
  userName: string;
  canWrite: boolean;
  isCurrentConnection: boolean;
  line?: number;
  column?: number;
};

export type RealtimeStatus = "connecting" | "connected" | "disconnected";
export type ReconnectState = {
  active: boolean;
  secondsRemaining: number;
  attempt: number;
};

type CursorPayload = {
  line: number;
  column: number;
};

const DEFAULT_RECONNECT_DELAY_SECONDS = 5;
const RECONNECT_COUNTDOWN_TICK_MS = 1_000;
const SNAPSHOT_DEBOUNCE_MS = 320;
const SNAPSHOT_ACK_TIMEOUT_MS = 10_000;

const SERVER_EVENT_KINDS = new Set<RealtimeServerEvent["kind"]>([
  "yjs.update",
  "yjs.sync",
  "yjs.ack",
  "presence.join",
  "presence.leave",
  "presence.meta",
  "presence.cursor",
  "bootstrap.done",
  "workspace.changed",
  "document.changed",
  "project.replaced",
  "access.changed",
  "server.error",
]);

function sendRealtimeMessage(
  socket: WebSocket,
  message: RealtimeClientMessage,
) {
  socket.send(JSON.stringify(message));
}

export function parseRealtimeServerEvent(
  value: unknown,
): RealtimeServerEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.doc_id !== "string" ||
    typeof record.user_id !== "string" ||
    !(
      record.connection_id === undefined ||
      record.connection_id === null ||
      typeof record.connection_id === "string"
    ) ||
    typeof record.is_current_connection !== "boolean" ||
    typeof record.kind !== "string" ||
    !SERVER_EVENT_KINDS.has(record.kind as RealtimeServerEvent["kind"]) ||
    typeof record.at !== "string" ||
    !("payload" in record)
  ) {
    return null;
  }
  return record as RealtimeServerEvent;
}

const WORKSPACE_CHANGE_SCOPES = new Set<
  RealtimeWorkspaceChangedPayload["scope"]
>(["document", "tree", "settings", "assets"]);

export function parseWorkspaceChangedPayload(
  value: unknown,
): RealtimeWorkspaceChangedPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.scope !== "string" ||
    !WORKSPACE_CHANGE_SCOPES.has(
      record.scope as RealtimeWorkspaceChangedPayload["scope"],
    ) ||
    !(record.path === null || typeof record.path === "string") ||
    !(record.document_id === null || typeof record.document_id === "string") ||
    !(
      record.collaboration_revision === null ||
      (typeof record.collaboration_revision === "number" &&
        Number.isSafeInteger(record.collaboration_revision) &&
        record.collaboration_revision >= 0)
    ) ||
    !(
      record.change_sequence === null ||
      (typeof record.change_sequence === "number" &&
        Number.isSafeInteger(record.change_sequence) &&
        record.change_sequence >= 0)
    )
  ) {
    return null;
  }
  if (
    record.scope === "document" &&
    (typeof record.path !== "string" ||
      typeof record.document_id !== "string" ||
      typeof record.collaboration_revision !== "number" ||
      typeof record.change_sequence !== "number")
  ) {
    return null;
  }
  return {
    scope: record.scope as RealtimeWorkspaceChangedPayload["scope"],
    path: record.path,
    document_id: record.document_id,
    collaboration_revision: record.collaboration_revision,
    change_sequence: record.change_sequence,
  };
}

export function bindRealtimeYDoc(params: {
  docId: string;
  collaborationRevision: number;
  projectId: string;
  wsBaseUrl: string;
  ydoc: Y.Doc;
  userId?: string;
  userName?: string;
  sessionToken?: string;
  shareToken?: string;
  guestSession?: string;
  canWrite?: boolean;
  onPresenceChange?: (sessions: PresenceSession[]) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  onReconnectChange?: (state: ReconnectState) => void;
  onBootstrapDone?: () => void;
  onSnapshotAcknowledged?: (content: string) => void;
  onDocumentChanged?: () => void;
  onProjectReplaced?: () => void;
  onAccessChanged?: () => void;
  reconnectDelaySeconds?: number;
}) {
  const userId = params.userId ?? crypto.randomUUID();
  const userName = params.userName?.trim() || `User-${userId.slice(0, 8)}`;
  const canWrite = params.canWrite ?? true;
  const reconnectDelaySeconds = Math.max(
    1,
    Math.floor(
      params.reconnectDelaySeconds ?? DEFAULT_RECONNECT_DELAY_SECONDS,
    ),
  );
  const query = new URLSearchParams({
    project_id: params.projectId,
    collaboration_revision: String(params.collaborationRevision),
    user_id: userId,
    user_name: userName,
  });
  if (params.sessionToken?.trim()) {
    query.set("session_token", params.sessionToken.trim());
  }
  if (params.shareToken?.trim()) {
    query.set("share_token", params.shareToken.trim());
  }
  if (params.guestSession?.trim()) {
    query.set("guest_session", params.guestSession.trim());
  }
  const safeDocId = encodeURIComponent(params.docId);
  const url = `${params.wsBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/realtime/ws/${safeDocId}?${query.toString()}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectCountdownTimer: number | null = null;
  let reconnectAttemptTimer: number | null = null;
  let reconnectSecondsRemaining = 0;
  let reconnectAttemptCount = 0;
  let bootstrapComplete = false;
  const origin = `client-${crypto.randomUUID()}`;
  const localPresenceSessionId = `local:${origin}`;
  let requestSequence = 0;
  let snapshotTimer: number | null = null;
  const pendingSnapshots = new Map<
    string,
    {
      content: string;
      timeout: number;
      resolve: (acknowledged: boolean) => void;
    }
  >();
  const presenceSessions = new Map<string, PresenceSession>();

  const addLocalPresenceSession = () => {
    presenceSessions.set(localPresenceSessionId, {
      connectionId: localPresenceSessionId,
      userId,
      userName,
      canWrite,
      isCurrentConnection: true,
    });
  };

  addLocalPresenceSession();

  const notifyPresence = () => {
    params.onPresenceChange?.(Array.from(presenceSessions.values()));
  };

  const resetPresenceToSelf = () => {
    presenceSessions.clear();
    addLocalPresenceSession();
    notifyPresence();
  };

  const notifyReconnect = (active: boolean, secondsRemaining: number) => {
    params.onReconnectChange?.({
      active,
      secondsRemaining,
      attempt: reconnectAttemptCount,
    });
  };

  const stopReconnectCountdown = () => {
    if (reconnectCountdownTimer !== null) {
      window.clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    if (reconnectAttemptTimer !== null) {
      window.clearTimeout(reconnectAttemptTimer);
      reconnectAttemptTimer = null;
    }
    reconnectSecondsRemaining = 0;
    notifyReconnect(false, 0);
  };

  const nextRequestId = () => `${origin}:${++requestSequence}`;

  const settlePendingSnapshots = (acknowledged: boolean) => {
    for (const pending of pendingSnapshots.values()) {
      window.clearTimeout(pending.timeout);
      pending.resolve(acknowledged);
    }
    pendingSnapshots.clear();
  };

  const clearSnapshotTimer = () => {
    if (snapshotTimer === null) return;
    window.clearTimeout(snapshotTimer);
    snapshotTimer = null;
  };

  const startReconnectCountdown = () => {
    if (closed) return;
    if (reconnectAttemptTimer !== null) return;
    params.onStatusChange?.("disconnected");
    resetPresenceToSelf();
    reconnectAttemptCount += 1;
    reconnectSecondsRemaining = reconnectDelaySeconds;
    notifyReconnect(true, reconnectSecondsRemaining);
    reconnectCountdownTimer = window.setInterval(() => {
      if (closed) return;
      reconnectSecondsRemaining = Math.max(0, reconnectSecondsRemaining - 1);
      notifyReconnect(true, reconnectSecondsRemaining);
    }, RECONNECT_COUNTDOWN_TICK_MS);
    reconnectAttemptTimer = window.setTimeout(() => {
      if (closed) return;
      stopReconnectCountdown();
      connect();
    }, reconnectDelaySeconds * RECONNECT_COUNTDOWN_TICK_MS);
  };

  const sendSnapshotTo = (socket: WebSocket): Promise<boolean> => {
    if (!canWrite || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    const snapshot = Y.encodeStateAsUpdate(params.ydoc);
    const requestId = nextRequestId();
    const content = params.ydoc.getText("main").toString();
    return new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingSnapshots.delete(requestId);
        resolve(false);
      }, SNAPSHOT_ACK_TIMEOUT_MS);
      pendingSnapshots.set(requestId, { content, timeout, resolve });
      sendRealtimeMessage(socket, {
        kind: "yjs.sync",
        origin,
        request_id: requestId,
        payload: bytesToBase64(snapshot),
      });
    });
  };

  const onLocalUpdate = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === "remote") return;
    clearSnapshotTimer();
    snapshotTimer = window.setTimeout(() => {
      snapshotTimer = null;
      if (ws) void sendSnapshotTo(ws);
    }, SNAPSHOT_DEBOUNCE_MS);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRealtimeMessage(ws, {
        kind: "yjs.update",
        origin,
        request_id: nextRequestId(),
        payload: bytesToBase64(update),
      });
    }
  };

  params.ydoc.on("update", onLocalUpdate);

  const connect = () => {
    if (closed) return;
    stopReconnectCountdown();
    params.onStatusChange?.("connecting");
    const socket = new WebSocket(url);
    ws = socket;
    bootstrapComplete = false;

    const sendPresenceMetadata = () => {
      if (closed || ws !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      sendRealtimeMessage(socket, {
        kind: "presence.meta",
        origin,
        payload: {
          user_name: userName,
          can_write: canWrite,
        },
      });
    };

    socket.addEventListener("open", () => {
      if (closed || ws !== socket) return;
      params.onStatusChange?.("connected");
      reconnectAttemptCount = 0;
      stopReconnectCountdown();
      notifyPresence();
      sendPresenceMetadata();
    });

    socket.addEventListener("message", (event) => {
      if (closed || ws !== socket) return;
      try {
        const parsed = parseRealtimeServerEvent(JSON.parse(String(event.data)));
        if (!parsed) return;
        const incoming = parsed.payload;
        const incomingRecord =
          incoming && typeof incoming === "object"
            ? (incoming as Record<string, unknown>)
            : null;
        const kind = parsed.kind;
        const eventUserId = parsed.user_id;
        const presenceSessionId =
          parsed.connection_id ?? `member:${eventUserId}`;
        const payloadUserName =
          typeof incomingRecord?.user_name === "string"
            ? incomingRecord.user_name
            : undefined;
        const payloadCanWrite =
          typeof incomingRecord?.can_write === "boolean"
            ? incomingRecord.can_write
            : true;

        if (
          parsed.is_current_connection &&
          parsed.connection_id &&
          (kind === "presence.join" ||
            kind === "presence.meta" ||
            kind === "presence.cursor")
        ) {
          // The local placeholder makes the editor immediately show the
          // current participant. Once the server identifies a real session,
          // remove that placeholder so it is not counted as another tab.
          presenceSessions.delete(localPresenceSessionId);
        }

        if (kind === "yjs.ack") {
          const requestId = incomingRecord?.request_id;
          const projected = incomingRecord?.projected === true;
          if (typeof requestId === "string") {
            const pending = pendingSnapshots.get(requestId);
            if (pending) {
              window.clearTimeout(pending.timeout);
              pendingSnapshots.delete(requestId);
              if (projected) {
                params.onSnapshotAcknowledged?.(pending.content);
              }
              pending.resolve(projected);
            }
          }
          return;
        }

        if (kind === "presence.join" && eventUserId) {
          const previous = presenceSessions.get(presenceSessionId);
          presenceSessions.set(presenceSessionId, {
            connectionId: presenceSessionId,
            userId: eventUserId,
            userName: payloadUserName || previous?.userName || eventUserId,
            canWrite: payloadCanWrite,
            isCurrentConnection: parsed.is_current_connection,
          });
          notifyPresence();
          // The broadcast channel does not retain a roster. Every existing
          // connection answers a join so a new tab can discover other
          // sessions even when they belong to the same account.
          sendPresenceMetadata();
        }
        if (kind === "presence.leave" && eventUserId) {
          presenceSessions.delete(presenceSessionId);
          notifyPresence();
        }
        if (kind === "presence.meta" && eventUserId) {
          const previous: PresenceSession = presenceSessions.get(
            presenceSessionId,
          ) ?? {
            connectionId: presenceSessionId,
            userId: eventUserId,
            userName: eventUserId,
            canWrite: payloadCanWrite,
            isCurrentConnection: parsed.is_current_connection,
          };
          presenceSessions.set(presenceSessionId, {
            ...previous,
            userId: eventUserId,
            userName: payloadUserName || previous.userName,
            canWrite: payloadCanWrite,
            isCurrentConnection: parsed.is_current_connection,
          });
          notifyPresence();
        }
        if (kind === "presence.cursor" && eventUserId) {
          if (!payloadCanWrite) {
            return;
          }
          const previous: PresenceSession = presenceSessions.get(
            presenceSessionId,
          ) ?? {
            connectionId: presenceSessionId,
            userId: eventUserId,
            userName: eventUserId,
            canWrite: payloadCanWrite,
            isCurrentConnection: parsed.is_current_connection,
          };
          presenceSessions.set(presenceSessionId, {
            ...previous,
            userId: eventUserId,
            userName: payloadUserName || previous.userName,
            canWrite: payloadCanWrite,
            isCurrentConnection: parsed.is_current_connection,
            line:
              typeof incomingRecord?.line === "number" &&
              Number.isFinite(incomingRecord.line)
                ? Math.max(1, incomingRecord.line)
                : previous.line,
            column:
              typeof incomingRecord?.column === "number" &&
              Number.isFinite(incomingRecord.column)
                ? Math.max(1, incomingRecord.column)
                : previous.column,
          });
          notifyPresence();
        }
        if ((kind === "yjs.update" || kind === "yjs.sync") && incoming) {
          const maybePayload =
            typeof incoming === "string" ? incoming : incomingRecord?.payload;
          if (typeof maybePayload === "string") {
            Y.applyUpdate(params.ydoc, base64ToBytes(maybePayload), "remote");
          }
        }
        if (kind === "bootstrap.done") {
          bootstrapComplete = true;
          params.onBootstrapDone?.();
          void sendSnapshotTo(socket);
        }
        if (kind === "document.changed") {
          closed = true;
          stopReconnectCountdown();
          socket.close();
          params.onDocumentChanged?.();
        }
        if (kind === "project.replaced") {
          closed = true;
          stopReconnectCountdown();
          socket.close();
          params.onProjectReplaced?.();
        }
        if (kind === "access.changed") {
          closed = true;
          stopReconnectCountdown();
          socket.close();
          params.onAccessChanged?.();
        }
        if (
          kind === "server.error" &&
          incomingRecord?.resync_required === true
        ) {
          socket.close();
          startReconnectCountdown();
        }
      } catch {
        // Ignore malformed events.
      }
    });

    const handleDisconnect = () => {
      if (closed || ws !== socket) return;
      settlePendingSnapshots(false);
      startReconnectCountdown();
    };

    socket.addEventListener("error", handleDisconnect);
    socket.addEventListener("close", handleDisconnect);
  };

  notifyReconnect(false, 0);
  notifyPresence();
  connect();

  const sendCursor = (cursor: CursorPayload) => {
    if (!canWrite) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendRealtimeMessage(ws, {
      kind: "presence.cursor",
      origin,
      payload: {
        line: Math.max(1, Math.floor(cursor.line)),
        column: Math.max(1, Math.floor(cursor.column)),
        user_name: userName,
        can_write: canWrite,
      },
    });
  };

  const sendSyncSnapshot = (): Promise<boolean> => {
    if (!canWrite || !bootstrapComplete) return Promise.resolve(false);
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    clearSnapshotTimer();
    return sendSnapshotTo(ws);
  };

  const reconnectNow = () => {
    if (closed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
      return;
    }
    if (
      ws.readyState === WebSocket.CONNECTING ||
      ws.readyState === WebSocket.OPEN
    )
      return;
    if (ws.readyState === WebSocket.CLOSING) return;
    connect();
  };

  const close = () => {
    // A WebSocket close cannot be used as a durability barrier: sending a
    // snapshot and immediately closing does not guarantee delivery. Local Yjs
    // persistence retains unacknowledged changes for the next binding, while
    // Cmd/Ctrl+S explicitly waits for sendSyncSnapshot's acknowledgement.
    clearSnapshotTimer();
    closed = true;
    stopReconnectCountdown();
    params.ydoc.off("update", onLocalUpdate);
    settlePendingSnapshots(false);
    presenceSessions.clear();
    notifyPresence();
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close();
    }
    ws = null;
    params.onStatusChange?.("disconnected");
  };

  return { close, sendCursor, reconnectNow, sendSyncSnapshot };
}
