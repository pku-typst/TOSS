import { assign, fromCallback, setup } from "xstate";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  bindRealtimeYDoc,
  type PresenceSession,
  type RealtimeStatus,
  type ReconnectState,
} from "@/lib/realtime";

export type RealtimeDocumentConfig = {
  sessionKey: string;
  projectId: string;
  documentId: string;
  collaborationRevision: number;
  userId: string;
  userName: string;
  shareToken: string | null;
  guestSession: string | null;
  canWrite: boolean;
};

export type RealtimeDocumentCommands = {
  sendCursor: (cursor: { line: number; column: number }) => void;
  reconnectNow: () => void;
  sendSyncSnapshot: () => Promise<boolean>;
};

export type RealtimeDocumentSession = {
  ydoc: Y.Doc;
  ytext: Y.Text;
  commands: RealtimeDocumentCommands;
  close: () => void;
};

export type RealtimeDocumentSessionEvents = {
  onPresenceChange: (presence: PresenceSession[]) => void;
  onStatusChange: (status: RealtimeStatus) => void;
  onReconnectChange: (reconnect: ReconnectState) => void;
  onReady: (content: string) => void;
  onSaved: (content: string) => void;
  onDocumentChanged: () => void;
  onProjectReplaced: () => void;
  onAccessChanged: () => void;
};

export type OpenRealtimeDocumentSession = (
  config: RealtimeDocumentConfig,
  events: RealtimeDocumentSessionEvents,
) => RealtimeDocumentSession;

export function openRealtimeDocumentSession(
  config: RealtimeDocumentConfig,
  events: RealtimeDocumentSessionEvents,
): RealtimeDocumentSession {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("main");
  let bootstrapResolved = false;

  if (config.canWrite && typeof globalThis.indexedDB !== "undefined") {
    const localDocumentId = [
      "typst-collab",
      config.userId,
      config.projectId,
      config.documentId,
      config.collaborationRevision,
    ].join(":");
    new IndexeddbPersistence(localDocumentId, ydoc);
  }

  const resolveBootstrap = () => {
    if (bootstrapResolved) return;
    bootstrapResolved = true;
    events.onReady(ytext.toString());
  };

  const binding = bindRealtimeYDoc({
    docId: config.documentId,
    collaborationRevision: config.collaborationRevision,
    projectId: config.projectId,
    wsBaseUrl: window.location.origin,
    ydoc,
    userId: config.userId,
    userName: config.userName,
    shareToken: config.shareToken ?? undefined,
    guestSession: config.guestSession ?? undefined,
    canWrite: config.canWrite,
    onPresenceChange: events.onPresenceChange,
    onStatusChange: events.onStatusChange,
    onReconnectChange: events.onReconnectChange,
    onBootstrapDone: () => {
      resolveBootstrap();
    },
    onSnapshotAcknowledged: events.onSaved,
    onDocumentChanged: events.onDocumentChanged,
    onProjectReplaced: events.onProjectReplaced,
    onAccessChanged: events.onAccessChanged,
  });
  let closed = false;

  return {
    ydoc,
    ytext,
    commands: binding,
    close: () => {
      if (closed) return;
      closed = true;
      binding.close();
      ydoc.destroy();
    },
  };
}

type RealtimeDocumentMachineInput = {
  openSession: OpenRealtimeDocumentSession;
  onProjectReplaced: () => void;
  onAccessChanged: () => void;
};

type RealtimeDocumentContext = RealtimeDocumentMachineInput & {
  config: RealtimeDocumentConfig | null;
  session: RealtimeDocumentSession | null;
  presence: PresenceSession[];
  reconnect: ReconnectState;
  readyContent: string | null;
};

type RealtimeDocumentEvent =
  | { type: "bind"; config: RealtimeDocumentConfig }
  | { type: "disable" }
  | { type: "session.opened"; session: RealtimeDocumentSession }
  | { type: "session.ready"; content: string }
  | { type: "session.saved"; content: string }
  | { type: "presence.changed"; presence: PresenceSession[] }
  | { type: "status.connecting" }
  | { type: "status.connected" }
  | { type: "status.disconnected" }
  | { type: "reconnect.changed"; reconnect: ReconnectState }
  | { type: "document.changed" }
  | { type: "project.replaced" }
  | { type: "access.changed" };

type BindingActorInput = {
  config: RealtimeDocumentConfig;
  openSession: OpenRealtimeDocumentSession;
};

const manageRealtimeBinding = fromCallback<
  RealtimeDocumentEvent,
  BindingActorInput
>(({ input, sendBack }) => {
  const session = input.openSession(input.config, {
    onPresenceChange: (presence) => {
      sendBack({ type: "presence.changed", presence });
    },
    onStatusChange: (status) => {
      sendBack({ type: `status.${status}` });
    },
    onReconnectChange: (reconnect) => {
      sendBack({ type: "reconnect.changed", reconnect });
    },
    onReady: (content) => {
      sendBack({ type: "session.ready", content });
    },
    onSaved: (content) => {
      sendBack({ type: "session.saved", content });
    },
    onDocumentChanged: () => {
      sendBack({ type: "document.changed" });
    },
    onProjectReplaced: () => {
      sendBack({ type: "project.replaced" });
    },
    onAccessChanged: () => {
      sendBack({ type: "access.changed" });
    },
  });
  sendBack({ type: "session.opened", session });
  return () => session.close();
});

const EMPTY_RECONNECT_STATE: ReconnectState = {
  active: false,
  secondsRemaining: 0,
  attempt: 0,
};

/** Owns one active Yjs document binding and its connection lifecycle. */
export const realtimeDocumentMachine = setup({
  types: {
    context: {} as RealtimeDocumentContext,
    events: {} as RealtimeDocumentEvent,
    input: {} as RealtimeDocumentMachineInput,
  },
  actors: { manageRealtimeBinding },
  guards: {
    isCurrentBinding: ({ context, event }) =>
      event.type === "bind" &&
      context.config?.sessionKey === event.config.sessionKey,
  },
  actions: {
    configureBinding: assign(({ event }) => {
      if (event.type !== "bind") return {};
      return {
        config: event.config,
        session: null,
        presence: [],
        reconnect: EMPTY_RECONNECT_STATE,
        readyContent: null,
      };
    }),
    clearBinding: assign({
      config: null,
      session: null,
      presence: [],
      reconnect: EMPTY_RECONNECT_STATE,
      readyContent: null,
    }),
  },
}).createMachine({
  id: "realtimeDocument",
  initial: "inactive",
  context: ({ input }) => ({
    ...input,
    config: null,
    session: null,
    presence: [],
    reconnect: EMPTY_RECONNECT_STATE,
    readyContent: null,
  }),
  states: {
    inactive: {
      on: {
        bind: {
          target: "active",
          actions: "configureBinding",
        },
      },
    },
    active: {
      type: "parallel",
      invoke: {
        src: "manageRealtimeBinding",
        input: ({ context }) => {
          if (!context.config) {
            throw new Error(
              "A realtime binding requires document configuration",
            );
          }
          return {
            config: context.config,
            openSession: context.openSession,
          };
        },
      },
      on: {
        bind: [
          { guard: "isCurrentBinding" },
          {
            target: "active",
            reenter: true,
            actions: "configureBinding",
          },
        ],
        disable: {
          target: "inactive",
          actions: "clearBinding",
        },
        "session.opened": {
          actions: assign(({ event }) => ({ session: event.session })),
        },
        "session.saved": {
          actions: assign(({ event }) => ({ readyContent: event.content })),
        },
        "presence.changed": {
          actions: assign(({ event }) => ({ presence: event.presence })),
        },
        "reconnect.changed": {
          actions: assign(({ event }) => ({ reconnect: event.reconnect })),
        },
        "document.changed": {
          target: "superseded",
          actions: "clearBinding",
        },
        "project.replaced": {
          target: "replaced",
          actions: "clearBinding",
        },
        "access.changed": {
          target: "accessInvalidated",
          actions: "clearBinding",
        },
      },
      states: {
        document: {
          initial: "bootstrapping",
          states: {
            bootstrapping: {
              on: {
                "session.ready": {
                  target: "ready",
                  actions: assign(({ event }) => ({
                    readyContent: event.content,
                  })),
                },
              },
            },
            ready: {},
          },
        },
        connection: {
          initial: "connecting",
          states: {
            connecting: {
              on: {
                "status.connected": { target: "connected" },
                "status.disconnected": { target: "disconnected" },
              },
            },
            connected: {
              on: {
                "status.connecting": { target: "connecting" },
                "status.disconnected": { target: "disconnected" },
              },
            },
            disconnected: {
              on: {
                "status.connecting": { target: "connecting" },
                "status.connected": { target: "connected" },
              },
            },
          },
        },
      },
    },
    superseded: {
      on: {
        bind: {
          target: "active",
          actions: "configureBinding",
        },
        disable: {
          target: "inactive",
          actions: "clearBinding",
        },
      },
    },
    replaced: {
      entry: ({ context }) => context.onProjectReplaced(),
    },
    accessInvalidated: {
      entry: ({ context }) => context.onAccessChanged(),
    },
  },
});
