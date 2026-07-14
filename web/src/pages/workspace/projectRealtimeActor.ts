import { assign, fromCallback, setup } from "xstate";
import {
  bindProjectRealtime,
  type ProjectRealtimeBinding,
} from "@/lib/projectRealtime";
import type { RealtimeStatus } from "@/lib/realtime";
import type { RealtimeWorkspaceChangedPayload } from "@/lib/api/types";

export type ProjectRealtimeConfig = {
  sessionKey: string;
  projectId: string;
  userId: string;
  shareToken: string | null;
  guestSession: string | null;
};

export type ProjectRealtimeEvents = {
  onStatusChange: (status: RealtimeStatus) => void;
  onBootstrapDone: () => void;
  onWorkspaceChanged: (change: RealtimeWorkspaceChangedPayload) => void;
  onProjectReplaced: () => void;
  onAccessChanged: () => void;
};

export type OpenProjectRealtime = (
  config: ProjectRealtimeConfig,
  events: ProjectRealtimeEvents,
) => ProjectRealtimeBinding;

type ProjectRealtimeInput = {
  open: OpenProjectRealtime;
  onProjectReplaced: () => void;
  onAccessChanged: () => void;
};

type ProjectRealtimeContext = ProjectRealtimeInput & {
  config: ProjectRealtimeConfig | null;
  status: RealtimeStatus;
  catchUpSequence: number;
  workspaceChangeSequence: number;
  structuralChangeSequence: number;
  documentChanges: Record<string, ProjectDocumentChange>;
};

export type ProjectDocumentChange = {
  sequence: number;
  documentId: string;
  collaborationRevision: number;
  changeSequence: number;
};

type ProjectRealtimeEvent =
  | { type: "bind"; config: ProjectRealtimeConfig }
  | { type: "disable" }
  | { type: "status.changed"; status: RealtimeStatus }
  | { type: "bootstrap.done" }
  | {
      type: "workspace.changed";
      change: RealtimeWorkspaceChangedPayload;
    }
  | { type: "project.replaced" }
  | { type: "access.changed" };

const manageProjectBinding = fromCallback<
  ProjectRealtimeEvent,
  {
    config: ProjectRealtimeConfig;
    open: ProjectRealtimeInput["open"];
  }
>(({ input, sendBack }) => {
  const binding = input.open(input.config, {
    onStatusChange: (status) => sendBack({ type: "status.changed", status }),
    onBootstrapDone: () => sendBack({ type: "bootstrap.done" }),
    onWorkspaceChanged: (change) =>
      sendBack({ type: "workspace.changed", change }),
    onProjectReplaced: () => sendBack({ type: "project.replaced" }),
    onAccessChanged: () => sendBack({ type: "access.changed" }),
  });
  return () => binding.close();
});

export function openProjectRealtime(
  config: ProjectRealtimeConfig,
  events: ProjectRealtimeEvents,
) {
  return bindProjectRealtime({
    projectId: config.projectId,
    wsBaseUrl: window.location.origin,
    userId: config.userId,
    shareToken: config.shareToken ?? undefined,
    guestSession: config.guestSession ?? undefined,
    ...events,
  });
}

export const projectRealtimeMachine = setup({
  types: {
    context: {} as ProjectRealtimeContext,
    events: {} as ProjectRealtimeEvent,
    input: {} as ProjectRealtimeInput,
  },
  actors: { manageProjectBinding },
  guards: {
    isCurrentBinding: ({ context, event }) =>
      event.type === "bind" &&
      context.config?.sessionKey === event.config.sessionKey,
  },
}).createMachine({
  id: "projectRealtime",
  initial: "inactive",
  context: ({ input }) => ({
    ...input,
    config: null,
    status: "disconnected",
    catchUpSequence: 0,
    workspaceChangeSequence: 0,
    structuralChangeSequence: 0,
    documentChanges: {},
  }),
  states: {
    inactive: {
      on: {
        bind: {
          target: "active",
          actions: assign(({ event }) => ({
            config: event.config,
            status: "connecting" as const,
          })),
        },
      },
    },
    active: {
      invoke: {
        src: "manageProjectBinding",
        input: ({ context }) => {
          if (!context.config) {
            throw new Error(
              "A project realtime binding requires configuration",
            );
          }
          return { config: context.config, open: context.open };
        },
      },
      on: {
        bind: [
          { guard: "isCurrentBinding" },
          {
            target: "active",
            reenter: true,
            actions: assign(({ event }) => ({
              config: event.config,
              status: "connecting" as const,
            })),
          },
        ],
        disable: {
          target: "inactive",
          actions: assign({ config: null, status: "disconnected" }),
        },
        "status.changed": {
          actions: assign(({ event }) => ({ status: event.status })),
        },
        "bootstrap.done": {
          actions: assign(({ context }) => ({
            catchUpSequence: context.catchUpSequence + 1,
          })),
        },
        "workspace.changed": {
          actions: assign(({ context, event }) => {
            const sequence = context.workspaceChangeSequence + 1;
            if (
              event.change.scope === "document" &&
              event.change.path !== null &&
              event.change.document_id !== null &&
              event.change.collaboration_revision !== null &&
              event.change.change_sequence !== null
            ) {
              const existing = context.documentChanges[event.change.path];
              const nextChange = {
                sequence,
                documentId: event.change.document_id,
                collaborationRevision: event.change.collaboration_revision,
                changeSequence: event.change.change_sequence,
              };
              return {
                workspaceChangeSequence: sequence,
                documentChanges: {
                  ...context.documentChanges,
                  [event.change.path]:
                    existing &&
                    existing.changeSequence > nextChange.changeSequence
                      ? existing
                      : nextChange,
                },
              };
            }
            return {
              workspaceChangeSequence: sequence,
              structuralChangeSequence: sequence,
              documentChanges: {},
            };
          }),
        },
        "project.replaced": { target: "replaced" },
        "access.changed": { target: "accessInvalidated" },
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
