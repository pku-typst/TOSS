import * as Y from "yjs";
import type { CollaborationBackend } from "@/collaboration/collaborationBackend";
import { BrowserWorkspaceStore } from "@/browserBackend/browserWorkspaceStore";

const BOOTSTRAP_ORIGIN = Symbol("browser-document-bootstrap");
const REMOTE_ORIGIN = Symbol("browser-document-remote");

type DocumentChannelMessage = {
  sender: string;
  update: ArrayBuffer;
};

function ownBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createBrowserCollaborationBackend(
  store: BrowserWorkspaceStore,
): CollaborationBackend {
  return {
    openProject(config, events) {
      let closed = false;
      const unsubscribe = store.events.subscribe(config.projectId, (change) => {
        if (!closed) events.onWorkspaceChanged(change);
      });
      queueMicrotask(() => {
        if (closed) return;
        events.onStatusChange("connected");
        events.onBootstrapDone();
      });
      return {
        close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          events.onStatusChange("disconnected");
        },
      };
    },

    openDocument(config, events) {
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText("main");
      const sender = crypto.randomUUID();
      const channel =
        typeof BroadcastChannel === "undefined"
          ? null
          : new BroadcastChannel(
              `toss-browser-document-v1:${config.projectId}:${config.documentId}:${config.collaborationRevision}`,
            );
      let closed = false;
      let persistence = Promise.resolve();
      let persistenceFailed = false;

      const persist = (update: Uint8Array) => {
        const stored = ownBuffer(update);
        persistence = persistence
          .catch(() => undefined)
          .then(() =>
            store.mergeDocumentUpdate(
              config.projectId,
              config.documentId,
              new Uint8Array(stored),
            ),
          )
          .then((document) => {
            persistenceFailed = false;
            if (!closed) channel?.postMessage({ sender, update: stored } satisfies DocumentChannelMessage);
            if (!closed) events.onSaved(document.content);
          })
          .catch(() => {
            persistenceFailed = true;
            if (!closed) events.onStatusChange("disconnected");
          });
      };

      ydoc.on("update", (update, origin) => {
        if (closed || origin === BOOTSTRAP_ORIGIN || origin === REMOTE_ORIGIN) return;
        persist(update);
      });

      if (channel) {
        channel.onmessage = (event: MessageEvent<DocumentChannelMessage>) => {
          const message = event.data;
          if (closed || !message || message.sender === sender || !(message.update instanceof ArrayBuffer)) {
            return;
          }
          Y.applyUpdate(ydoc, new Uint8Array(message.update), REMOTE_ORIGIN);
        };
      }

      void store
        .loadDocumentState(config.projectId, config.documentId)
        .then(({ update }) => {
          if (closed) return;
          Y.applyUpdate(ydoc, update, BOOTSTRAP_ORIGIN);
          events.onStatusChange("connected");
          events.onReconnectChange({ active: false, secondsRemaining: 0, attempt: 0 });
          events.onPresenceChange([]);
          events.onReady(ytext.toString());
        })
        .catch(() => {
          if (closed) return;
          events.onStatusChange("disconnected");
        });

      return {
        ydoc,
        ytext,
        commands: {
          sendCursor: () => undefined,
          reconnectNow: () => {
            if (!closed) events.onStatusChange("connected");
          },
          async sendSyncSnapshot() {
            await persistence;
            if (closed || persistenceFailed) return false;
            events.onSaved(ytext.toString());
            return true;
          },
        },
        close() {
          if (closed) return;
          closed = true;
          channel?.close();
          events.onStatusChange("disconnected");
          ydoc.destroy();
        },
      };
    },
  };
}
