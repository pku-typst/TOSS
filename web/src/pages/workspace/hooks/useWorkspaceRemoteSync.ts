import { useActorRef, useSelector } from "@xstate/react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
} from "react";
import { waitFor } from "xstate";
import { saveProjectSnapshotToCache } from "@/lib/projectCache";
import type {
  AssetMeta,
} from "@/pages/workspace/types";
import type { ProjectDocumentChange } from "@/pages/workspace/projectRealtimeActor";
import type { WorkspaceSessionActor } from "@/pages/workspace/workspaceSessionActor";
import {
  workspaceDeltaMachine,
  type CompletedWorkspaceDelta,
  type WorkspaceDeltaJob,
  type WorkspaceDeltaRequest
} from "@/pages/workspace/workspaceDeltaActor";
import { useWorkspaceBackend } from "@/workspace/workspaceBackend";

type UseWorkspaceRemoteSyncInput = {
  sessionActor: WorkspaceSessionActor;
  workspaceSyncPending: boolean;
  realtimeCatchUpSequence: number;
  workspaceChangeSequence: number;
  workspaceStructuralChangeSequence: number;
  workspaceDocumentChanges: Record<string, ProjectDocumentChange>;
  isRevisionMode: boolean;
  hasActiveLiveDocument: boolean;
  activeLiveDocumentReady: boolean;
  activeDocumentText: string;
  lastSavedDocument: string;
  reconcileAssetCatalog: (assetMeta: Record<string, AssetMeta>) => void;
};

export function useWorkspaceRemoteSync(input: UseWorkspaceRemoteSyncInput) {
  const workspaceBackend = useWorkspaceBackend();
  const projectionSnapshot = useSelector(
    input.sessionActor,
    (current) => current,
  );
  const projection = projectionSnapshot.context;
  const syncActor = useActorRef(workspaceDeltaMachine, {
    input: {
      load: workspaceBackend.loadDelta
    }
  });
  const snapshot = useSelector(syncActor, (current) => current);
  const enabled =
    !!projection.scope.projectId &&
    projectionSnapshot.matches("available") &&
    !input.isRevisionMode &&
    !input.workspaceSyncPending;
  const request = useMemo<WorkspaceDeltaRequest>(
    () => ({
      projectId: projection.scope.projectId,
      projectType: projection.projectType,
      latexEngine: projection.latexEngine,
      entryFilePath: projection.entryFilePath,
      afterDocumentsChangeSequence: projection.documentsChangeSequence,
    }),
    [
      projection.documentsChangeSequence,
      projection.entryFilePath,
      projection.latexEngine,
      projection.projectType,
      projection.scope.projectId,
    ],
  );
  const job = useMemo<WorkspaceDeltaJob>(
    () => ({
      sessionGeneration: projection.scope.generation,
      request,
    }),
    [projection.scope.generation, request],
  );

  useEffect(() => {
    if (enabled) {
      syncActor.send({ type: "configure", job });
    } else {
      syncActor.send({ type: "disable" });
    }
  }, [enabled, job, syncActor]);

  const observedSignalsRef = useRef({
    sessionGeneration: projection.scope.generation,
    catchUp: input.realtimeCatchUpSequence,
    workspace: input.workspaceChangeSequence
  });
  useEffect(() => {
    const observed = observedSignalsRef.current;
    if (
      observed.sessionGeneration !== projection.scope.generation
    ) {
      observedSignalsRef.current = {
        sessionGeneration: projection.scope.generation,
        catchUp: input.realtimeCatchUpSequence,
        workspace: input.workspaceChangeSequence
      };
      return;
    }
    if (
      !enabled ||
      (input.hasActiveLiveDocument && !input.activeLiveDocumentReady)
    ) {
      return;
    }
    if (
      observed.catchUp === input.realtimeCatchUpSequence &&
      observed.workspace === input.workspaceChangeSequence
    ) {
      return;
    }
    const catchUpRequired =
      observed.catchUp !== input.realtimeCatchUpSequence;
    const structuralChangeRequired =
      input.workspaceStructuralChangeSequence > observed.workspace;
    const activeIdentity =
      projection.documentIdentities[projection.activePath];
    const documentChangeRequired = Object.entries(
      input.workspaceDocumentChanges
    ).some(
      ([path, change]) =>
        change.sequence > observed.workspace &&
        (path !== projection.activePath ||
          !activeIdentity ||
          change.documentId !== activeIdentity.id ||
          change.collaborationRevision !==
            activeIdentity.collaborationRevision)
    );
    observedSignalsRef.current = {
      sessionGeneration: projection.scope.generation,
      catchUp: input.realtimeCatchUpSequence,
      workspace: input.workspaceChangeSequence
    };
    if (
      catchUpRequired ||
      structuralChangeRequired ||
      documentChangeRequired
    ) {
      syncActor.send({ type: "sync.requested" });
    }
  }, [
    enabled,
    input.activeLiveDocumentReady,
    input.hasActiveLiveDocument,
    input.realtimeCatchUpSequence,
    input.workspaceDocumentChanges,
    input.workspaceStructuralChangeSequence,
    input.workspaceChangeSequence,
    projection.activePath,
    projection.documentIdentities,
    projection.scope.generation,
    syncActor
  ]);

  const applyCompleted = useEffectEvent(
    (completed: CompletedWorkspaceDelta) => {
      if (
        projection.scope.generation !== completed.job.sessionGeneration ||
        input.isRevisionMode
      ) {
        return false;
      }
      if (completed.result.status === "error") {
        input.sessionActor.send({
          type: "delta.failed",
          generation: completed.job.sessionGeneration,
        });
        return true;
      }
      const activeDocumentDirty =
        !!projection.activePath &&
        input.hasActiveLiveDocument &&
        input.activeDocumentText !== input.lastSavedDocument;
      input.sessionActor.send({
        type: "delta.succeeded",
        generation: completed.job.sessionGeneration,
        delta: completed.result.delta,
        activeDocument: {
          path: projection.activePath,
          dirty: activeDocumentDirty,
          text: input.activeDocumentText,
        },
      });
      const nextSnapshot = input.sessionActor.getSnapshot();
      if (!nextSnapshot.matches("replaced")) {
        const next = nextSnapshot.context;
        saveProjectSnapshotToCache({
          cacheIdentity: next.scope.cacheIdentity,
          projectId: next.scope.projectId,
          entryFilePath: next.entryFilePath,
          nodes: next.nodes,
          docs: next.documents,
        });
        input.reconcileAssetCatalog(next.assetMeta);
      }
      return true;
    }
  );

  useEffect(() => {
    const completed = snapshot.context.completed;
    if (!completed) return;
    const applied = applyCompleted(completed);
    if (applied && completed.result.status === "success") {
      const next = input.sessionActor.getSnapshot().context;
      syncActor.send({
        type: "configure",
        job: {
          sessionGeneration: completed.job.sessionGeneration,
          request: {
            projectId: completed.job.request.projectId,
            projectType: next.projectType,
            latexEngine: next.latexEngine,
            entryFilePath: next.entryFilePath,
            afterDocumentsChangeSequence: next.documentsChangeSequence,
          },
        },
      });
    }
    syncActor.send({ type: "result.applied", cycle: completed.cycle });
  }, [input.sessionActor, snapshot.context.completed, syncActor]);

  return useCallback(async () => {
    const before = syncActor.getSnapshot();
    if (!before.matches("enabled")) return;
    const requestedGeneration = before.context.job?.sessionGeneration;
    if (!requestedGeneration) return;
    syncActor.send({ type: "sync.requested" });
    const ticket = syncActor.getSnapshot().context.requestedTicket;
    await waitFor(
      syncActor,
      (current) =>
        current.matches("inactive") ||
        current.context.job?.sessionGeneration !== requestedGeneration ||
        current.context.settledTicket >= ticket
    ).catch(() => undefined);
  }, [syncActor]);
}
