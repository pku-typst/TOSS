import { useActorRef, useSelector } from "@xstate/react";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
} from "react";
import type { Project } from "@/lib/api";
import {
  loadProjectSnapshotFromCache,
  saveProjectSnapshotToCache,
} from "@/lib/projectCache";
import {
  defaultEntryForProjectType,
} from "@/pages/workspace/loaders";
import { useWorkspaceAssets } from "@/pages/workspace/hooks/useWorkspaceAssets";
import {
  createEmptyWorkspaceSession,
  workspaceSessionMachine,
  type WorkspaceSessionScope,
} from "@/pages/workspace/workspaceSessionActor";
import { useWorkspaceBackend } from "@/workspace/workspaceBackend";
import type { WorkspaceBootstrap } from "@/workspace/workspaceSnapshot";

type UseWorkspaceSessionInput = {
  projectId: string;
  project: Project | undefined;
  effectiveUserId: string;
  offlineCacheIdentity: string | null;
  accessSessionKey: string;
  canWrite: boolean;
  cachedOfflineMessage: string;
  loadErrorMessage: string;
};

type BootstrapApplication = {
  bootstrap: WorkspaceBootstrap;
  promise: Promise<void>;
};

export function useWorkspaceSession(input: UseWorkspaceSessionInput) {
  const workspaceBackend = useWorkspaceBackend();
  const {
    canWrite,
    effectiveUserId,
    offlineCacheIdentity,
    accessSessionKey,
    project,
    projectId,
  } = input;
  const projectTypeHint = project?.project_type ?? "typst";
  const defaultEntry = defaultEntryForProjectType(projectTypeHint);
  const templateUnavailable = !!project?.is_template && !project.can_read;
  const sessionGeneration = JSON.stringify([
    accessSessionKey,
    projectId,
    templateUnavailable,
    canWrite,
  ]);
  const scope = useMemo<WorkspaceSessionScope>(
    () => ({
      generation: sessionGeneration,
      projectId,
      cacheIdentity: offlineCacheIdentity ?? "",
      projectTypeHint,
      latexEngineHint: project?.latex_engine ?? "xetex",
      defaultEntry,
      unavailable: templateUnavailable,
    }),
    [
      defaultEntry,
      offlineCacheIdentity,
      sessionGeneration,
      project?.latex_engine,
      projectId,
      projectTypeHint,
      templateUnavailable,
    ],
  );
  const sessionActor = useActorRef(workspaceSessionMachine, {
    input: scope,
  });
  const sessionSnapshot = useSelector(
    sessionActor,
    (snapshot) => snapshot,
  );
  const actorProjection = sessionSnapshot.context;
  const projectionIsCurrent =
    actorProjection.scope.generation === sessionGeneration;
  const projection = projectionIsCurrent
    ? actorProjection
    : createEmptyWorkspaceSession(scope);
  const assets = useWorkspaceAssets({
    projectId,
    effectiveUserId,
    sessionGeneration,
    assetMeta: projection.assetMeta,
  });
  const {
    reconcileAssetCatalog,
    hydrateProjectAssetsForInitialLoad,
    resetAssetLoading,
  } = assets;
  const bootstrapApplicationRef = useRef<BootstrapApplication | null>(null);

  const cachedSnapshots = useMemo(() => {
    if (!offlineCacheIdentity || !projectId) {
      return { any: null, fresh: null };
    }
    const any = loadProjectSnapshotFromCache(offlineCacheIdentity, projectId);
    const parsedServerLastEditedMs = project?.last_edited_at
      ? Date.parse(project.last_edited_at)
      : Number.NaN;
    const serverLastEditedMs = Number.isFinite(parsedServerLastEditedMs)
      ? parsedServerLastEditedMs
      : null;
    const minFreshCacheMs =
      serverLastEditedMs === null
        ? undefined
        : Math.max(0, serverLastEditedMs - 3000);
    return {
      any,
      fresh: loadProjectSnapshotFromCache(offlineCacheIdentity, projectId, {
        minCachedAtMs: minFreshCacheMs,
      }),
    };
  }, [offlineCacheIdentity, project?.last_edited_at, projectId]);

  const initializeScope = useEffectEvent(() => {
    bootstrapApplicationRef.current = null;
    resetAssetLoading();
    reconcileAssetCatalog({});
    sessionActor.send({
      type: "session.started",
      scope,
      seed: templateUnavailable ? null : cachedSnapshots.fresh,
    });
  });

  useEffect(() => {
    initializeScope();
  }, [sessionGeneration]);

  const applyServerBootstrap = useCallback(
    (bootstrap: WorkspaceBootstrap) => {
      if (
        sessionActor.getSnapshot().context.scope.generation !==
        sessionGeneration
      ) {
        return Promise.resolve();
      }
      const currentApplication = bootstrapApplicationRef.current;
      if (currentApplication?.bootstrap === bootstrap) {
        return currentApplication.promise;
      }
      const promise = (async () => {
        if (
          sessionActor.getSnapshot().context.scope.generation !==
          sessionGeneration
        ) {
          return;
        }
        sessionActor.send({
          type: "bootstrap.succeeded",
          generation: sessionGeneration,
          bootstrap,
        });
        saveProjectSnapshotToCache({
          cacheIdentity: offlineCacheIdentity ?? "",
          projectId,
          entryFilePath: bootstrap.entryFilePath,
          nodes: bootstrap.nodes,
          docs: bootstrap.documents,
        });
        reconcileAssetCatalog(bootstrap.assetMeta);
        await hydrateProjectAssetsForInitialLoad(
          bootstrap.documents,
          bootstrap.assetMeta,
        );
      })();
      bootstrapApplicationRef.current = { bootstrap, promise };
      return promise;
    },
    [
      offlineCacheIdentity,
      hydrateProjectAssetsForInitialLoad,
      sessionGeneration,
      projectId,
      sessionActor,
      reconcileAssetCatalog,
    ],
  );

  const handleBootstrapFailure = useCallback(
    (loadError: unknown) => {
      const current = sessionActor.getSnapshot();
      if (current.context.scope.generation !== sessionGeneration) {
        return;
      }
      sessionActor.send({
        type: "bootstrap.failed",
        generation: sessionGeneration,
        fallback: current.matches("loading") ? cachedSnapshots.any : null,
        message: cachedSnapshots.any
          ? input.cachedOfflineMessage
          : loadError instanceof Error
            ? loadError.message
            : input.loadErrorMessage,
      });
    },
    [
      cachedSnapshots.any,
      input.cachedOfflineMessage,
      input.loadErrorMessage,
      sessionGeneration,
      sessionActor,
    ],
  );

  const bootstrapQuery = useQuery({
    queryKey: [
      "workspace-bootstrap",
      sessionGeneration,
      projectTypeHint,
      canWrite,
    ],
    queryFn: () =>
      workspaceBackend.loadBootstrap({
        projectId,
        projectTypeHint,
        canWrite,
      }),
    enabled: !!projectId && !templateUnavailable,
    retry: false,
  });

  useEffect(() => {
    if (!bootstrapQuery.data || bootstrapQuery.dataUpdatedAt === 0) return;
    void applyServerBootstrap(bootstrapQuery.data);
  }, [applyServerBootstrap, bootstrapQuery.data, bootstrapQuery.dataUpdatedAt]);

  useEffect(() => {
    if (!bootstrapQuery.isError || bootstrapQuery.errorUpdatedAt === 0) return;
    handleBootstrapFailure(bootstrapQuery.error);
  }, [
    bootstrapQuery.error,
    bootstrapQuery.errorUpdatedAt,
    bootstrapQuery.isError,
    handleBootstrapFailure,
  ]);

  const refetchBootstrap = bootstrapQuery.refetch;
  const refresh = useCallback(async () => {
    if (!projectId || templateUnavailable) return;
    const requestedGeneration = sessionGeneration;
    const result = await refetchBootstrap();
    if (
      sessionActor.getSnapshot().context.scope.generation !==
      requestedGeneration
    ) {
      return;
    }
    if (result.isError) {
      handleBootstrapFailure(result.error);
      return;
    }
    if (result.data && result.dataUpdatedAt > 0) {
      await applyServerBootstrap(result.data);
      return;
    }
    handleBootstrapFailure(result.error);
  }, [
    applyServerBootstrap,
    handleBootstrapFailure,
    sessionGeneration,
    projectId,
    sessionActor,
    refetchBootstrap,
    templateUnavailable,
  ]);

  const selectActivePath = useCallback(
    (path: string) => {
      sessionActor.send({
        type: "active-path.selected",
        generation: sessionGeneration,
        path,
      });
    },
    [sessionActor, sessionGeneration],
  );
  const updateDocumentContent = useCallback(
    (path: string, content: string) => {
      sessionActor.send({
        type: "document-content.updated",
        generation: sessionGeneration,
        path,
        content,
      });
    },
    [sessionActor, sessionGeneration],
  );

  return {
    actor: sessionActor,
    projection,
    assets,
    status: {
      loaded:
        projectionIsCurrent &&
        (sessionSnapshot.matches("available") ||
          sessionSnapshot.matches("unavailable")),
      offline:
        projectionIsCurrent &&
        sessionSnapshot.matches({ available: "offline" }),
      contentReplaced:
        projectionIsCurrent && sessionSnapshot.matches("replaced"),
      syncPending: bootstrapQuery.isFetching,
    },
    commands: {
      refresh,
      selectActivePath,
      updateDocumentContent,
    },
  };
}
