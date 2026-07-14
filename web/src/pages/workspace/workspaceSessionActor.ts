import { assign, setup, type ActorRefFrom } from "xstate";
import type {
  LatexEngine,
  ProjectShareLink,
} from "@/lib/api";
import type { CachedProjectSnapshot } from "@/lib/projectCache";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import { sameProjectNodeList } from "@/pages/workspace/equality";
import type {
  WorkspaceBootstrap,
  WorkspaceDelta,
} from "@/pages/workspace/loaders";
import { mergeWorkspaceDocumentDelta } from "@/pages/workspace/sync";
import type {
  AssetMeta,
  DocumentIdentity,
  ProjectNode,
} from "@/pages/workspace/types";
import { pickWorkspaceOpenPath } from "@/pages/workspace/utils";

export type WorkspaceSessionScope = {
  generation: string;
  projectId: string;
  cacheIdentity: string;
  projectTypeHint: ProjectType;
  latexEngineHint: LatexEngine;
  defaultEntry: string;
  unavailable: boolean;
};

export type WorkspaceSessionContext = {
  scope: WorkspaceSessionScope;
  nodes: ProjectNode[];
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  settingsRevision: number;
  contentEpoch: number | null;
  activePath: string;
  documents: Record<string, string>;
  documentIdentities: Record<string, DocumentIdentity>;
  documentsChangeSequence: number | null;
  assetMeta: Record<string, AssetMeta>;
  gitRepoUrl: string;
  shareLinks: ProjectShareLink[];
  offlineMessage: string | null;
};

export type ActiveDocumentProjection = {
  path: string;
  dirty: boolean;
  text: string;
};

type WorkspaceSessionEvent =
  | {
      type: "session.started";
      scope: WorkspaceSessionScope;
      seed: CachedProjectSnapshot | null;
    }
  | {
      type: "bootstrap.succeeded";
      generation: string;
      bootstrap: WorkspaceBootstrap;
    }
  | {
      type: "bootstrap.failed";
      generation: string;
      fallback: CachedProjectSnapshot | null;
      message: string;
    }
  | {
      type: "delta.succeeded";
      generation: string;
      delta: WorkspaceDelta;
      activeDocument: ActiveDocumentProjection;
    }
  | { type: "delta.failed"; generation: string }
  | { type: "active-path.selected"; generation: string; path: string }
  | {
      type: "document-content.updated";
      generation: string;
      path: string;
      content: string;
    }
  | {
      type: "settings.synchronized";
      generation: string;
      projectType: ProjectType;
      latexEngine: LatexEngine;
      entryFilePath: string;
      settingsRevision: number;
    }
  | {
      type: "share-links.replaced";
      generation: string;
      shareLinks: ProjectShareLink[];
    };

export function createEmptyWorkspaceSession(
  scope: WorkspaceSessionScope,
): WorkspaceSessionContext {
  return {
    scope,
    nodes: [],
    projectType: scope.projectTypeHint,
    latexEngine: scope.latexEngineHint,
    entryFilePath: scope.defaultEntry,
    settingsRevision: -1,
    contentEpoch: null,
    activePath: scope.defaultEntry,
    documents: {},
    documentIdentities: {},
    documentsChangeSequence: null,
    assetMeta: {},
    gitRepoUrl: "",
    shareLinks: [],
    offlineMessage: null,
  };
}

function projectionFromSeed(
  scope: WorkspaceSessionScope,
  seed: CachedProjectSnapshot,
): WorkspaceSessionContext {
  const entryFilePath = seed.entryFilePath || scope.defaultEntry;
  return {
    ...createEmptyWorkspaceSession(scope),
    nodes: seed.nodes,
    entryFilePath,
    activePath: pickWorkspaceOpenPath(
      seed.nodes,
      entryFilePath,
      scope.defaultEntry,
    ),
    documents: seed.docs,
  };
}

function applyBootstrap(
  context: WorkspaceSessionContext,
  bootstrap: WorkspaceBootstrap,
): WorkspaceSessionContext {
  const acceptsSettings =
    bootstrap.settingsRevision >= context.settingsRevision;
  const entryFilePath = acceptsSettings
    ? bootstrap.entryFilePath
    : context.entryFilePath;
  const activePath = bootstrap.nodes.some(
    (node) => node.kind === "file" && node.path === context.activePath,
  )
    ? context.activePath
    : pickWorkspaceOpenPath(
        bootstrap.nodes,
        entryFilePath,
        context.activePath,
      );
  return {
    ...context,
    nodes: bootstrap.nodes,
    projectType: bootstrap.projectType,
    latexEngine: acceptsSettings ? bootstrap.latexEngine : context.latexEngine,
    entryFilePath,
    settingsRevision: acceptsSettings
      ? bootstrap.settingsRevision
      : context.settingsRevision,
    contentEpoch: bootstrap.contentEpoch,
    activePath,
    documents: bootstrap.documents,
    documentIdentities: bootstrap.documentIdentities,
    documentsChangeSequence: bootstrap.documentsChangeSequence,
    assetMeta: bootstrap.assetMeta,
    gitRepoUrl: bootstrap.gitRepoUrl,
    shareLinks: bootstrap.shareLinks,
    offlineMessage: null,
  };
}

function applyDelta(
  context: WorkspaceSessionContext,
  event: Extract<WorkspaceSessionEvent, { type: "delta.succeeded" }>,
): Partial<WorkspaceSessionContext> {
  const { activeDocument, delta } = event;
  const acceptsSettings = delta.settingsRevision >= context.settingsRevision;
  const entryFilePath = acceptsSettings
    ? delta.entryFilePath
    : context.entryFilePath;
  const documents = mergeWorkspaceDocumentDelta({
    current: context.documents,
    incoming: delta.documents,
    nodes: delta.nodes,
    activePath: activeDocument.path,
    activeDocumentDirty: activeDocument.dirty,
    activeDocumentText: activeDocument.text,
  });
  const mergedIdentities = {
    ...context.documentIdentities,
    ...delta.documentIdentities,
  };
  const liveDocumentPaths = new Set(Object.keys(documents));
  const documentIdentities = Object.fromEntries(
    Object.entries(mergedIdentities).filter(([path]) =>
      liveDocumentPaths.has(path),
    ),
  );
  const filePaths = new Set(
    delta.nodes
      .filter((node) => node.kind === "file")
      .map((node) => node.path),
  );
  const activePath = filePaths.has(context.activePath)
    ? context.activePath
    : pickWorkspaceOpenPath(
        delta.nodes,
        entryFilePath,
        context.activePath,
      );

  return {
    offlineMessage: null,
    projectType: delta.projectType,
    latexEngine: acceptsSettings ? delta.latexEngine : context.latexEngine,
    nodes: sameProjectNodeList(context.nodes, delta.nodes)
      ? context.nodes
      : delta.nodes,
    entryFilePath,
    settingsRevision: acceptsSettings
      ? delta.settingsRevision
      : context.settingsRevision,
    contentEpoch: delta.contentEpoch,
    activePath,
    documents,
    documentIdentities,
    documentsChangeSequence: delta.documentsChangeSequence,
    assetMeta: delta.assetMeta,
  };
}

/** Owns one Workspace browser session and its canonical read projection. */
export const workspaceSessionMachine = setup({
  types: {
    context: {} as WorkspaceSessionContext,
    events: {} as WorkspaceSessionEvent,
    input: {} as WorkspaceSessionScope,
  },
  guards: {
    configuredAsUnavailable: ({ event }) =>
      event.type === "session.started" && event.scope.unavailable,
    configuredWithSeed: ({ event }) =>
      event.type === "session.started" && event.seed !== null,
    eventTargetsCurrentSession: ({ context, event }) =>
      "generation" in event &&
      event.generation === context.scope.generation,
    currentDeltaReplacesContent: ({ context, event }) =>
      event.type === "delta.succeeded" &&
      event.generation === context.scope.generation &&
      context.contentEpoch !== null &&
      event.delta.contentEpoch !== context.contentEpoch,
  },
  actions: {
    startEmptySession: assign(({ event }) =>
      event.type === "session.started"
        ? createEmptyWorkspaceSession(event.scope)
        : {},
    ),
    startCachedSession: assign(({ event }) =>
      event.type === "session.started" && event.seed
        ? projectionFromSeed(event.scope, event.seed)
        : {},
    ),
    applyBootstrap: assign(({ context, event }) =>
      event.type === "bootstrap.succeeded"
        ? applyBootstrap(context, event.bootstrap)
        : {},
    ),
    applyBootstrapFailure: assign(({ context, event }) => {
      if (event.type !== "bootstrap.failed") return {};
      const fallback = event.fallback
        ? projectionFromSeed(context.scope, event.fallback)
        : context;
      return {
        ...fallback,
        offlineMessage: event.message,
      };
    }),
    applyDelta: assign(({ context, event }) =>
      event.type === "delta.succeeded" ? applyDelta(context, event) : {},
    ),
    selectActivePath: assign(({ event }) =>
      event.type === "active-path.selected"
        ? { activePath: event.path }
        : {},
    ),
    updateDocumentContent: assign(({ context, event }) => {
      if (
        event.type !== "document-content.updated" ||
        context.documents[event.path] === event.content
      ) {
        return {};
      }
      return {
        documents: {
          ...context.documents,
          [event.path]: event.content,
        },
      };
    }),
    synchronizeSettings: assign(({ context, event }) =>
      event.type === "settings.synchronized" &&
      event.settingsRevision >= context.settingsRevision
        ? {
            projectType: event.projectType,
            latexEngine: event.latexEngine,
            entryFilePath: event.entryFilePath,
            settingsRevision: event.settingsRevision,
          }
        : {},
    ),
    replaceShareLinks: assign(({ event }) =>
      event.type === "share-links.replaced"
        ? { shareLinks: event.shareLinks }
        : {},
    ),
  },
}).createMachine({
  id: "workspaceSession",
  initial: "loading",
  context: ({ input }) => createEmptyWorkspaceSession(input),
  on: {
    "session.started": [
      {
        guard: "configuredAsUnavailable",
        target: ".unavailable",
        actions: "startEmptySession",
      },
      {
        guard: "configuredWithSeed",
        target: ".available.cached",
        actions: "startCachedSession",
      },
      {
        target: ".loading",
        actions: "startEmptySession",
      },
    ],
  },
  states: {
    loading: {
      on: {
        "bootstrap.succeeded": {
          guard: "eventTargetsCurrentSession",
          target: "available.online",
          actions: "applyBootstrap",
        },
        "bootstrap.failed": {
          guard: "eventTargetsCurrentSession",
          target: "available.offline",
          actions: "applyBootstrapFailure",
        },
      },
    },
    available: {
      initial: "cached",
      on: {
        "bootstrap.succeeded": {
          guard: "eventTargetsCurrentSession",
          target: ".online",
          actions: "applyBootstrap",
        },
        "bootstrap.failed": {
          guard: "eventTargetsCurrentSession",
          target: ".offline",
          actions: "applyBootstrapFailure",
        },
        "delta.succeeded": [
          {
            guard: "currentDeltaReplacesContent",
            target: "#workspaceSession.replaced",
          },
          {
            guard: "eventTargetsCurrentSession",
            target: ".online",
            actions: "applyDelta",
          },
        ],
        "delta.failed": {
          guard: "eventTargetsCurrentSession",
          target: ".offline",
        },
        "active-path.selected": {
          guard: "eventTargetsCurrentSession",
          actions: "selectActivePath",
        },
        "document-content.updated": {
          guard: "eventTargetsCurrentSession",
          actions: "updateDocumentContent",
        },
        "settings.synchronized": {
          guard: "eventTargetsCurrentSession",
          actions: "synchronizeSettings",
        },
        "share-links.replaced": {
          guard: "eventTargetsCurrentSession",
          actions: "replaceShareLinks",
        },
      },
      states: {
        cached: {},
        online: {},
        offline: {},
      },
    },
    unavailable: {},
    replaced: {},
  },
});

export type WorkspaceSessionActor = ActorRefFrom<
  typeof workspaceSessionMachine
>;
