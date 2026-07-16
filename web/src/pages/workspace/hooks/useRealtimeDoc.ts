import { useActorRef, useSelector } from "@xstate/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { EditorChange } from "@/components/EditorPane";
import type { RealtimeStatus, ReconnectState } from "@/lib/realtime";
import type { DocumentIdentity } from "@/pages/workspace/types";
import {
  openRealtimeDocumentSession,
  realtimeDocumentMachine,
  type RealtimeDocumentConfig,
  type RealtimeDocumentSession,
} from "@/pages/workspace/realtimeDocumentActor";

type UseRealtimeDocParams = {
  projectId: string;
  activePath: string;
  docs: Record<string, string>;
  documentIdentities: Record<string, DocumentIdentity>;
  workspaceLoaded: boolean;
  isRevisionMode: boolean;
  canWrite: boolean;
  effectiveUserId: string;
  effectiveUserName: string;
  shareToken?: string | null;
  guestSession?: string | null;
};

const INACTIVE_RECONNECT_STATE: ReconnectState = {
  active: false,
  secondsRemaining: 0,
  attempt: 0,
};

export function useRealtimeDoc({
  projectId,
  activePath,
  docs,
  documentIdentities,
  workspaceLoaded,
  isRevisionMode,
  canWrite,
  effectiveUserId,
  effectiveUserName,
  shareToken,
  guestSession,
}: UseRealtimeDocParams) {
  const hasActiveLiveDoc = useMemo(
    () => Object.prototype.hasOwnProperty.call(docs, activePath),
    [activePath, docs],
  );
  const activeDocumentIdentity = documentIdentities[activePath] ?? null;
  const sessionConfig = useMemo<RealtimeDocumentConfig | null>(() => {
    if (
      !projectId ||
      !activePath ||
      !workspaceLoaded ||
      isRevisionMode ||
      !hasActiveLiveDoc ||
      !activeDocumentIdentity
    ) {
      return null;
    }
    return {
      sessionKey: JSON.stringify([
        projectId,
        activeDocumentIdentity.id,
        activeDocumentIdentity.collaborationRevision,
        effectiveUserId,
        effectiveUserName,
        shareToken ?? null,
        guestSession ?? null,
        canWrite,
      ]),
      projectId,
      documentId: activeDocumentIdentity.id,
      collaborationRevision: activeDocumentIdentity.collaborationRevision,
      userId: effectiveUserId,
      userName: effectiveUserName,
      shareToken: shareToken ?? null,
      guestSession: guestSession ?? null,
      canWrite,
    };
  }, [
    activePath,
    canWrite,
    activeDocumentIdentity,
    effectiveUserId,
    effectiveUserName,
    guestSession,
    hasActiveLiveDoc,
    isRevisionMode,
    projectId,
    shareToken,
    workspaceLoaded,
  ]);
  const realtimeActor = useActorRef(realtimeDocumentMachine, {
    input: {
      openSession: openRealtimeDocumentSession,
      onProjectReplaced: () => window.location.reload(),
      onAccessChanged: () => window.location.reload(),
    },
  });
  const snapshot = useSelector(realtimeActor, (current) => current);

  useEffect(() => {
    if (sessionConfig) {
      realtimeActor.send({ type: "bind", config: sessionConfig });
    } else {
      realtimeActor.send({ type: "disable" });
    }
  }, [realtimeActor, sessionConfig]);

  const sessionKey = sessionConfig?.sessionKey ?? null;
  const bindingIsCurrent =
    !!sessionKey && snapshot.context.config?.sessionKey === sessionKey;
  const session = bindingIsCurrent ? snapshot.context.session : null;
  const realtimeDocReady =
    bindingIsCurrent && snapshot.matches({ active: { document: "ready" } });
  const subscribeToDocument = useCallback(
    (notify: () => void) => {
      if (!session) return () => undefined;
      const observer = () => notify();
      session.ytext.observe(observer);
      return () => session.ytext.unobserve(observer);
    },
    [session],
  );
  const readDocument = useCallback(
    () => (session && realtimeDocReady ? session.ytext.toString() : ""),
    [realtimeDocReady, session],
  );
  const docText = useSyncExternalStore(
    subscribeToDocument,
    readDocument,
    readDocument,
  );

  const lastSavedDocument =
    bindingIsCurrent && snapshot.context.readyContent !== null
      ? snapshot.context.readyContent
      : "";

  const withCurrentSession = useCallback(
    (action: (current: RealtimeDocumentSession) => void) => {
      if (!sessionKey) return;
      const current = realtimeActor.getSnapshot();
      if (current.context.config?.sessionKey !== sessionKey) return;
      if (!current.context.session) return;
      action(current.context.session);
    },
    [realtimeActor, sessionKey],
  );

  const applyDocumentDeltas = useCallback(
    (changes: EditorChange[]) => {
      if (isRevisionMode || !canWrite || changes.length === 0) return;
      withCurrentSession((current) => {
        if (
          !realtimeActor
            .getSnapshot()
            .matches({ active: { document: "ready" } })
        ) {
          return;
        }
        current.ydoc.transact(() => {
          const ordered = [...changes].sort(
            (a, b) => b.from - a.from || b.to - a.to,
          );
          for (const change of ordered) {
            const from = Math.max(0, change.from);
            const to = Math.max(from, change.to);
            const deleteCount = Math.max(0, to - from);
            if (deleteCount > 0) current.ytext.delete(from, deleteCount);
            if (change.insert) current.ytext.insert(from, change.insert);
          }
        });
      });
    },
    [canWrite, isRevisionMode, realtimeActor, withCurrentSession],
  );

  let realtimeStatus: RealtimeStatus = "disconnected";
  if (bindingIsCurrent) {
    if (snapshot.matches({ active: { connection: "connected" } })) {
      realtimeStatus = "connected";
    } else if (snapshot.matches({ active: { connection: "connecting" } })) {
      realtimeStatus = "connecting";
    }
  }

  const sendCursor = useCallback(
    (cursor: { line: number; column: number }) => {
      withCurrentSession((current) => current.commands.sendCursor(cursor));
    },
    [withCurrentSession],
  );
  const reconnectNow = useCallback(() => {
    withCurrentSession((current) => current.commands.reconnectNow());
  }, [withCurrentSession]);
  const sendSyncSnapshot = useCallback(() => {
    let result: Promise<boolean> = Promise.resolve(false);
    withCurrentSession((current) => {
      result = current.commands.sendSyncSnapshot();
    });
    return result;
  }, [withCurrentSession]);

  return {
    lastSavedDocument,
    presence: bindingIsCurrent ? snapshot.context.presence : [],
    realtimeStatus,
    reconnectState: bindingIsCurrent
      ? snapshot.context.reconnect
      : INACTIVE_RECONNECT_STATE,
    docText,
    realtimeDocReady,
    realtimeBoundPath: realtimeDocReady ? activePath : "",
    hasActiveLiveDoc,
    applyDocumentDeltas,
    sendCursor,
    reconnectNow,
    sendSyncSnapshot,
  };
}
