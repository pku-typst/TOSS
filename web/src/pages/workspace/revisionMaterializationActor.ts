import { assign, fromCallback, setup } from "xstate";
import type { RevisionTransfer } from "@/lib/api";
import { applyRevisionTransfer } from "@/pages/workspace/revisions";
import type { AssetMeta, ProjectNode } from "@/pages/workspace/types";

type RevisionDownloadProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type RevisionTransferOptions = {
  currentRevisionId?: string | null;
  includeLiveAnchor?: boolean;
};

export type RevisionTransferLoader = (
  projectId: string,
  revisionId: string,
  options: RevisionTransferOptions,
  onProgress: (progress: RevisionDownloadProgress) => void
) => Promise<RevisionTransfer>;

export type RevisionMaterializationRequest = {
  sessionGeneration: string;
  projectId: string;
  revisionId: string;
  liveDocs: Record<string, string>;
  liveAssets: Record<string, string>;
  liveAssetMeta: Record<string, AssetMeta>;
};

export type RevisionArtifact = {
  sessionGeneration: string;
  revisionId: string;
  documents: Record<string, string>;
  nodes: ProjectNode[];
  entryFilePath: string;
  assetBase64: Record<string, string>;
  assetMeta: Record<string, AssetMeta>;
};

export type RevisionLoadingState = {
  active: boolean;
  revisionId: string | null;
  loadedBytes: number;
  totalBytes: number | null;
};

export type RevisionMaterializationOutcome =
  | { status: "success"; revisionId: string }
  | { status: "error"; kind: "load" | "apply"; cause: unknown };

type RevisionMaterializationMachineInput = {
  initialSessionGeneration: string;
  load: RevisionTransferLoader;
};

type RevisionMaterializationContext = RevisionMaterializationMachineInput & {
  sessionGeneration: string;
  request: RevisionMaterializationRequest | null;
  artifact: RevisionArtifact | null;
  loading: RevisionLoadingState;
  outcome: RevisionMaterializationOutcome | null;
};

type RevisionMaterializationEvent =
  | { type: "session.started"; sessionGeneration: string }
  | { type: "open"; request: RevisionMaterializationRequest }
  | { type: "clear" }
  | {
      type: "load.progress";
      sessionGeneration: string;
      revisionId: string;
      progress: RevisionDownloadProgress;
    }
  | { type: "load.succeeded"; artifact: RevisionArtifact }
  | {
      type: "load.failed";
      sessionGeneration: string;
      revisionId: string;
      kind: "load" | "apply";
      cause: unknown;
    };

type LoadRevisionInput = {
  request: RevisionMaterializationRequest;
  currentArtifact: RevisionArtifact | null;
  load: RevisionTransferLoader;
};

async function materializeRevision(
  input: LoadRevisionInput,
  onProgress: (progress: RevisionDownloadProgress) => void
): Promise<RevisionArtifact | null> {
  const { currentArtifact, load, request } = input;
  const currentRevisionAnchorId = currentArtifact?.revisionId ?? null;
  const response = await load(
    request.projectId,
    request.revisionId,
    {
      currentRevisionId: currentRevisionAnchorId,
      includeLiveAnchor: true
    },
    onProgress
  );
  let transfer = applyRevisionTransfer({
    response,
    currentRevisionAnchorId,
    liveDocs: request.liveDocs,
    liveAssets: request.liveAssets,
    liveAssetMeta: request.liveAssetMeta,
    revisionDocs: currentArtifact?.documents ?? {},
    revisionAssets: currentArtifact?.assetBase64 ?? {},
    revisionAssetMeta: currentArtifact?.assetMeta ?? {}
  });

  if (!transfer.applied && response.transfer_mode === "delta") {
    const fallback = await load(
      request.projectId,
      request.revisionId,
      { includeLiveAnchor: false },
      onProgress
    );
    transfer = applyRevisionTransfer({
      response: fallback,
      forceFull: true,
      currentRevisionAnchorId,
      liveDocs: request.liveDocs,
      liveAssets: request.liveAssets,
      liveAssetMeta: request.liveAssetMeta,
      revisionDocs: currentArtifact?.documents ?? {},
      revisionAssets: currentArtifact?.assetBase64 ?? {},
      revisionAssetMeta: currentArtifact?.assetMeta ?? {}
    });
  }

  if (!transfer.applied) return null;
  return {
    sessionGeneration: request.sessionGeneration,
    revisionId: request.revisionId,
    documents: transfer.docs,
    nodes: transfer.nodes,
    entryFilePath: transfer.entryFilePath,
    assetBase64: transfer.assets,
    assetMeta: transfer.assetMeta
  };
}

const loadRevision = fromCallback<
  RevisionMaterializationEvent,
  LoadRevisionInput
>(({ input, sendBack }) => {
  let active = true;
  const onProgress = (progress: RevisionDownloadProgress) => {
    if (!active) return;
    sendBack({
      type: "load.progress",
      sessionGeneration: input.request.sessionGeneration,
      revisionId: input.request.revisionId,
      progress
    });
  };

  void materializeRevision(input, onProgress)
    .then((artifact) => {
      if (!active) return;
      if (artifact) {
        sendBack({ type: "load.succeeded", artifact });
      } else {
        sendBack({
          type: "load.failed",
          sessionGeneration: input.request.sessionGeneration,
          revisionId: input.request.revisionId,
          kind: "apply",
          cause: null
        });
      }
    })
    .catch((cause: unknown) => {
      if (!active) return;
      sendBack({
        type: "load.failed",
        sessionGeneration: input.request.sessionGeneration,
        revisionId: input.request.revisionId,
        kind: "load",
        cause
      });
    });

  return () => {
    active = false;
  };
});

const EMPTY_LOADING: RevisionLoadingState = {
  active: false,
  revisionId: null,
  loadedBytes: 0,
  totalBytes: null
};

/** Owns cancellation, progress, delta fallback, and publication of one revision view. */
export const revisionMaterializationMachine = setup({
  types: {
    context: {} as RevisionMaterializationContext,
    events: {} as RevisionMaterializationEvent,
    input: {} as RevisionMaterializationMachineInput
  },
  actors: { loadRevision },
  guards: {
    isActiveRevision: ({ context, event }) =>
      event.type === "open" &&
      event.request.sessionGeneration === context.sessionGeneration &&
      context.artifact?.sessionGeneration === event.request.sessionGeneration &&
      context.artifact?.revisionId === event.request.revisionId,
    requestTargetsCurrentSession: ({ context, event }) =>
      event.type === "open" &&
      event.request.sessionGeneration === context.sessionGeneration,
    isCurrentProgress: ({ context, event }) =>
      event.type === "load.progress" &&
      event.sessionGeneration === context.sessionGeneration &&
      context.request?.sessionGeneration === event.sessionGeneration &&
      context.request?.revisionId === event.revisionId,
    isCurrentSuccess: ({ context, event }) =>
      event.type === "load.succeeded" &&
      event.artifact.sessionGeneration === context.sessionGeneration &&
      context.request?.sessionGeneration === event.artifact.sessionGeneration &&
      context.request?.revisionId === event.artifact.revisionId,
    isCurrentFailure: ({ context, event }) =>
      event.type === "load.failed" &&
      event.sessionGeneration === context.sessionGeneration &&
      context.request?.sessionGeneration === event.sessionGeneration &&
      context.request?.revisionId === event.revisionId
  },
  actions: {
    startSession: assign(({ event }) =>
      event.type === "session.started"
        ? {
            sessionGeneration: event.sessionGeneration,
            request: null,
            artifact: null,
            loading: EMPTY_LOADING,
            outcome: null
          }
        : {}
    ),
    beginLoading: assign(({ event }) => {
      if (event.type !== "open") return {};
      return {
        request: event.request,
        loading: {
          active: true,
          revisionId: event.request.revisionId,
          loadedBytes: 0,
          totalBytes: null
        },
        outcome: null
      };
    }),
    clear: assign({
      request: null,
      artifact: null,
      loading: EMPTY_LOADING,
      outcome: null
    }),
    reportProgress: assign(({ event }) => {
      if (event.type !== "load.progress") return {};
      return {
        loading: {
          active: true,
          revisionId: event.revisionId,
          loadedBytes: event.progress.loadedBytes,
          totalBytes: event.progress.totalBytes
        }
      };
    }),
    publishArtifact: assign(({ event }) => {
      if (event.type !== "load.succeeded") return {};
      return {
        request: null,
        artifact: event.artifact,
        loading: {
          ...EMPTY_LOADING,
          revisionId: event.artifact.revisionId
        },
        outcome: {
          status: "success" as const,
          revisionId: event.artifact.revisionId
        }
      };
    }),
    publishFailure: assign(({ context, event }) => {
      if (event.type !== "load.failed") return {};
      return {
        request: null,
        loading: {
          ...EMPTY_LOADING,
          revisionId: event.revisionId
        },
        outcome: {
          status: "error" as const,
          kind: event.kind,
          cause: event.cause
        },
        artifact: context.artifact
      };
    })
  }
}).createMachine({
  id: "revisionMaterialization",
  initial: "idle",
  context: ({ input }) => ({
    ...input,
    sessionGeneration: input.initialSessionGeneration,
    request: null,
    artifact: null,
    loading: EMPTY_LOADING,
    outcome: null
  }),
  on: {
    "session.started": {
      target: ".idle",
      reenter: true,
      actions: "startSession"
    },
    clear: {
      target: ".idle",
      actions: "clear"
    },
    open: [
      {
        guard: "isActiveRevision",
        target: ".idle",
        actions: "clear"
      },
      {
        guard: "requestTargetsCurrentSession",
        target: ".loading",
        reenter: true,
        actions: "beginLoading"
      }
    ]
  },
  states: {
    idle: {},
    loading: {
      invoke: {
        src: "loadRevision",
        input: ({ context }) => {
          if (!context.request) {
            throw new Error("Revision loading requires a request");
          }
          return {
            request: context.request,
            currentArtifact: context.artifact,
            load: context.load
          };
        }
      },
      on: {
        "load.progress": {
          guard: "isCurrentProgress",
          actions: "reportProgress"
        },
        "load.succeeded": {
          guard: "isCurrentSuccess",
          target: "ready",
          actions: "publishArtifact"
        },
        "load.failed": {
          guard: "isCurrentFailure",
          target: "failed",
          actions: "publishFailure"
        }
      }
    },
    ready: {},
    failed: {}
  }
});
