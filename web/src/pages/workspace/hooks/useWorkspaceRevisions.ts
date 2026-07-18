import {
  useInfiniteQuery,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useActorRef, useSelector } from "@xstate/react";
import { useCallback, useEffect, useMemo } from "react";
import {
  createRevision as createProjectRevision,
  getRevisionDocuments,
  listRevisions,
  type Revision
} from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type { Translator } from "@/lib/i18n";
import {
  revisionMaterializationMachine
} from "@/pages/workspace/revisionMaterializationActor";
import type { AssetMeta, ProjectNode } from "@/pages/workspace/types";

const REVISION_PAGE_SIZE = 40;
const REVISION_REFRESH_INTERVAL_MS = 30_000;
const EMPTY_DOCUMENTS: Record<string, string> = {};
const EMPTY_NODES: ProjectNode[] = [];
const EMPTY_ASSET_META: Record<string, AssetMeta> = {};
const EMPTY_REVISIONS: Revision[] = [];
const EMPTY_LOADING = {
  active: false,
  revisionId: null,
  loadedBytes: 0,
  totalBytes: null
};

type RevisionHead = {
  revisions: Revision[];
  hasOlder: boolean;
};

type UseWorkspaceRevisionsInput = {
  projectId: string;
  sessionGeneration: string;
  workspaceLoaded: boolean;
  enabled: boolean;
  visible: boolean;
  projectType: ProjectType;
  liveDocs: Record<string, string>;
  liveAssets: Record<string, string>;
  liveAssetMeta: Record<string, AssetMeta>;
  t: Translator;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isRevisionHead(value: unknown): value is RevisionHead {
  return (
    typeof value === "object" &&
    value !== null &&
    "revisions" in value &&
    Array.isArray(value.revisions) &&
    "hasOlder" in value &&
    typeof value.hasOlder === "boolean"
  );
}

function mergeKnownRevisionHead(
  previous: RevisionHead | undefined,
  next: RevisionHead
): RevisionHead {
  if (!previous) return next;
  const sameHead = next.revisions.every(
    (revision, index) => revision.id === previous.revisions[index]?.id
  );
  if (sameHead && next.hasOlder === previous.hasOlder) return previous;

  const seen = new Set(next.revisions.map((revision) => revision.id));
  const revisions = [...next.revisions];
  for (const revision of previous.revisions) {
    if (seen.has(revision.id)) continue;
    seen.add(revision.id);
    revisions.push(revision);
  }
  return {
    revisions,
    hasOlder: next.hasOlder || previous.hasOlder
  };
}

function shareRevisionHead(previous: unknown, next: unknown): unknown {
  if (!isRevisionHead(next)) return next;
  return mergeKnownRevisionHead(
    isRevisionHead(previous) ? previous : undefined,
    next
  );
}

function flattenRevisionPages(
  head: Revision[],
  pages: { revisions: Revision[] }[] | undefined
): Revision[] {
  const seen = new Set<string>();
  const revisions: Revision[] = [];
  for (const page of [{ revisions: head }, ...(pages ?? [])]) {
    for (const revision of page.revisions || []) {
      if (seen.has(revision.id)) continue;
      seen.add(revision.id);
      revisions.push(revision);
    }
  }
  return revisions;
}

export function useWorkspaceRevisions({
  projectId,
  sessionGeneration,
  workspaceLoaded,
  enabled,
  visible,
  projectType,
  liveDocs,
  liveAssets,
  liveAssetMeta,
  t
}: UseWorkspaceRevisionsInput) {
  const queryClient = useQueryClient();
  const headQueryKey = useMemo(
    () => ["project-revisions", sessionGeneration, "head"] as const,
    [sessionGeneration]
  );
  const headQuery = useQuery({
    queryKey: headQueryKey,
    queryFn: async (): Promise<RevisionHead> => {
      const response = await listRevisions(projectId, {
        limit: REVISION_PAGE_SIZE
      });
      const revisions = response.revisions || [];
      return {
        revisions,
        hasOlder: revisions.length >= REVISION_PAGE_SIZE
      };
    },
    enabled: enabled && !!projectId && workspaceLoaded && visible,
    refetchInterval: REVISION_REFRESH_INTERVAL_MS,
    retry: false,
    structuralSharing: shareRevisionHead
  });
  const headRevisions = headQuery.data?.revisions ?? EMPTY_REVISIONS;
  const oldestHeadRevisionId = headRevisions.at(-1)?.id ?? null;
  const olderQuery = useInfiniteQuery({
    queryKey: ["project-revisions", sessionGeneration, "older"],
    queryFn: ({ pageParam }) =>
      listRevisions(projectId, {
        before: pageParam ?? undefined,
        limit: REVISION_PAGE_SIZE
      }),
    getNextPageParam: (lastPage) => {
      const revisions = lastPage.revisions || [];
      return revisions.length >= REVISION_PAGE_SIZE
        ? (revisions.at(-1)?.id ?? undefined)
        : undefined;
    },
    initialPageParam: oldestHeadRevisionId as string | null,
    enabled: false,
    retry: false
  });
  const revisions = useMemo(
    () => flattenRevisionPages(headRevisions, olderQuery.data?.pages),
    [headRevisions, olderQuery.data?.pages]
  );
  const createRevision = useCallback(
    async (summary: string) => {
      if (!enabled) throw new Error("workspace_revisions_unavailable");
      const created = await createProjectRevision(projectId, summary.trim());
      queryClient.setQueryData<RevisionHead>(headQueryKey, (previous) => ({
        revisions: [
          created,
          ...(previous?.revisions ?? []).filter(
            (revision) => revision.id !== created.id
          )
        ],
        hasOlder: previous?.hasOlder ?? false
      }));
    },
    [enabled, headQueryKey, projectId, queryClient]
  );

  const revisionActor = useActorRef(revisionMaterializationMachine, {
    input: {
      initialSessionGeneration: sessionGeneration,
      load: getRevisionDocuments
    }
  });
  const artifact = useSelector(
    revisionActor,
    (snapshot) => snapshot.context.artifact
  );
  const loading = useSelector(
    revisionActor,
    (snapshot) => snapshot.context.loading
  );
  const outcome = useSelector(
    revisionActor,
    (snapshot) => snapshot.context.outcome
  );

  const actorSessionIsCurrent =
    revisionActor.getSnapshot().context.sessionGeneration === sessionGeneration;
  const currentArtifact =
    actorSessionIsCurrent && artifact?.sessionGeneration === sessionGeneration
      ? artifact
      : null;
  const currentLoading = actorSessionIsCurrent ? loading : EMPTY_LOADING;
  const currentOutcome = actorSessionIsCurrent ? outcome : null;

  useEffect(() => {
    revisionActor.send({ type: "session.started", sessionGeneration });
  }, [revisionActor, sessionGeneration]);

  const materializationError = useMemo(() => {
    if (!currentOutcome || currentOutcome.status === "success") return null;
    if (currentOutcome.kind === "apply") return t("errors.applyRevision");
    return errorMessage(currentOutcome.cause, t("errors.loadRevision"));
  }, [currentOutcome, t]);
  const listError = headQuery.error ?? olderQuery.error;
  const error = materializationError ??
    (listError ? errorMessage(listError, t("errors.loadRevision")) : null);
  const clearSelection = useCallback(() => {
    revisionActor.send({ type: "clear" });
  }, [revisionActor]);

  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = olderQuery;
  const olderPagesLoaded = !!olderQuery.data;
  const hasMore = olderPagesLoaded
    ? hasNextPage
    : (headQuery.data?.hasOlder ?? false);
  const loadMore = useCallback(() => {
    if (
      !enabled ||
      !visible ||
      !hasMore ||
      isFetchingNextPage ||
      (!olderPagesLoaded && !oldestHeadRevisionId)
    ) {
      return;
    }
    void fetchNextPage();
  }, [
    fetchNextPage,
    enabled,
    hasMore,
    isFetchingNextPage,
    olderPagesLoaded,
    oldestHeadRevisionId,
    visible
  ]);

  const open = useCallback(
    (revisionId: string) => {
      if (!enabled || !projectId) return;
      revisionActor.send({
        type: "open",
        request: {
          projectId,
          sessionGeneration,
          revisionId,
          liveDocs,
          liveAssets,
          liveAssetMeta
        }
      });
    }, [
      enabled,
      liveAssetMeta,
      liveAssets,
      liveDocs,
      projectId,
      revisionActor,
      sessionGeneration
    ]
  );

  return {
    error,
    revisions,
    hasMore,
    loadingMore: isFetchingNextPage,
    activeRevisionId: currentArtifact?.revisionId ?? null,
    documents: currentArtifact?.documents ?? EMPTY_DOCUMENTS,
    nodes: currentArtifact?.nodes ?? EMPTY_NODES,
    entryFilePath:
      currentArtifact?.entryFilePath ??
      (projectType === "latex" ? "main.tex" : "main.typ"),
    assetBase64: currentArtifact?.assetBase64 ?? EMPTY_DOCUMENTS,
    assetMeta: currentArtifact?.assetMeta ?? EMPTY_ASSET_META,
    loading: currentLoading,
    createRevision,
    clearSelection,
    loadMore,
    open
  };
}
