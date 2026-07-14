import { assign, fromPromise, setup } from "xstate";
import type { LatexEngine } from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type { WorkspaceDelta } from "@/pages/workspace/loaders";

export const WORKSPACE_DELTA_INITIAL_RETRY_MS = 1000;

export type WorkspaceDeltaRequest = {
  projectId: string;
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  afterDocumentsChangeSequence: number | null;
};

export type WorkspaceDeltaJob = {
  sessionGeneration: string;
  request: WorkspaceDeltaRequest;
};

export type CompletedWorkspaceDelta = {
  cycle: number;
  job: WorkspaceDeltaJob;
  result:
    | { status: "success"; delta: WorkspaceDelta }
    | { status: "error"; error: unknown };
};

type WorkspaceDeltaMachineInput = {
  load: (request: WorkspaceDeltaRequest) => Promise<WorkspaceDelta>;
};

type WorkspaceDeltaContext = WorkspaceDeltaMachineInput & {
  job: WorkspaceDeltaJob | null;
  activeJob: WorkspaceDeltaJob | null;
  activeCycle: number;
  nextCycle: number;
  requestedTicket: number;
  activeTargetTicket: number;
  settledTicket: number;
  retryAttempt: number;
  completed: CompletedWorkspaceDelta | null;
};

type WorkspaceDeltaEvent =
  | { type: "configure"; job: WorkspaceDeltaJob }
  | { type: "disable" }
  | { type: "sync.requested" }
  | { type: "result.applied"; cycle: number };

type LoadWorkspaceDeltaOutput = {
  job: WorkspaceDeltaJob;
  delta: WorkspaceDelta;
};

const loadDelta = fromPromise<
  LoadWorkspaceDeltaOutput,
  {
    job: WorkspaceDeltaJob;
    load: WorkspaceDeltaMachineInput["load"];
  }
>(async ({ input }) => ({
  job: input.job,
  delta: await input.load(input.job.request)
}));

/**
 * Coalesces invalidations without consuming them on failure. Each request gets
 * a monotonic ticket; a ticket settles only after a successful delta is
 * applied, so manual synchronization cannot resolve on an older in-flight run.
 */
export const workspaceDeltaMachine = setup({
  types: {
    context: {} as WorkspaceDeltaContext,
    events: {} as WorkspaceDeltaEvent,
    input: {} as WorkspaceDeltaMachineInput
  },
  actors: { loadDelta },
  delays: {
    retryBackoff: ({ context }) =>
      Math.min(
        15_000,
        WORKSPACE_DELTA_INITIAL_RETRY_MS *
          2 ** Math.max(0, context.retryAttempt - 1)
      )
  },
  guards: {
    isSameSession: ({ context, event }) =>
      event.type === "configure" &&
      context.job?.sessionGeneration === event.job.sessionGeneration,
    isPublishedCycle: ({ context, event }) =>
      event.type === "result.applied" &&
      context.completed?.cycle === event.cycle,
    publishedCycleFailed: ({ context, event }) =>
      event.type === "result.applied" &&
      context.completed?.cycle === event.cycle &&
      context.completed.result.status === "error",
    publishedCycleSucceededWithNewerRequest: ({ context, event }) =>
      event.type === "result.applied" &&
      context.completed?.cycle === event.cycle &&
      context.completed.result.status === "success" &&
      context.requestedTicket > context.activeTargetTicket
  },
  actions: {
    configure: assign(({ event }) => {
      if (event.type !== "configure") return {};
      return { job: event.job };
    }),
    replaceConfiguration: assign(({ event }) => {
      if (event.type !== "configure") return {};
      return {
        job: event.job,
        activeJob: null,
        activeCycle: 0,
        activeTargetTicket: 0,
        completed: null,
        retryAttempt: 0
      };
    }),
    recordRequest: assign(({ context }) => ({
      requestedTicket: context.requestedTicket + 1
    })),
    beginCycle: assign(({ context }) => ({
      activeJob: context.job,
      activeCycle: context.nextCycle,
      activeTargetTicket: context.requestedTicket,
      nextCycle: context.nextCycle + 1,
      completed: null
    })),
    reset: assign({
      job: null,
      activeJob: null,
      activeCycle: 0,
      activeTargetTicket: 0,
      completed: null,
      retryAttempt: 0
    }),
    acknowledgeFailure: assign(({ context }) => ({
      completed: null,
      retryAttempt: context.retryAttempt + 1
    })),
    acknowledgeSuccess: assign(({ context }) => ({
      settledTicket: Math.max(
        context.settledTicket,
        context.activeTargetTicket
      ),
      completed: null,
      retryAttempt: 0
    })),
    acknowledgeSuccessAndBeginNext: assign(({ context }) => ({
      settledTicket: Math.max(
        context.settledTicket,
        context.activeTargetTicket
      ),
      activeJob: context.job,
      activeCycle: context.nextCycle,
      activeTargetTicket: context.requestedTicket,
      nextCycle: context.nextCycle + 1,
      completed: null,
      retryAttempt: 0
    }))
  }
}).createMachine({
  id: "workspaceDelta",
  initial: "inactive",
  context: ({ input }) => ({
    ...input,
    job: null,
    activeJob: null,
    activeCycle: 0,
    nextCycle: 1,
    requestedTicket: 0,
    activeTargetTicket: 0,
    settledTicket: 0,
    retryAttempt: 0,
    completed: null
  }),
  states: {
    inactive: {
      on: {
        configure: {
          target: "enabled",
          actions: "replaceConfiguration"
        }
      }
    },
    enabled: {
      initial: "idle",
      on: {
        configure: [
          { guard: "isSameSession", actions: "configure" },
          {
            target: "enabled",
            reenter: true,
            actions: "replaceConfiguration"
          }
        ],
        disable: { target: "inactive", actions: "reset" }
      },
      states: {
        idle: {
          on: {
            "sync.requested": {
              target: "syncing",
              actions: ["recordRequest", "beginCycle"]
            }
          }
        },
        syncing: {
          on: {
            "sync.requested": { actions: "recordRequest" }
          },
          invoke: {
            src: "loadDelta",
            input: ({ context }) => {
              if (!context.activeJob) {
                throw new Error("A workspace delta cycle requires a job");
              }
              return {
                job: context.activeJob,
                load: context.load
              };
            },
            onDone: {
              target: "publishing",
              actions: assign(({ context, event }) => ({
                completed: {
                  cycle: context.activeCycle,
                  job: event.output.job,
                  result: {
                    status: "success" as const,
                    delta: event.output.delta
                  }
                }
              }))
            },
            onError: {
              target: "publishing",
              actions: assign(({ context, event }) => ({
                completed: context.activeJob
                  ? {
                      cycle: context.activeCycle,
                      job: context.activeJob,
                      result: {
                        status: "error" as const,
                        error: event.error
                      }
                    }
                  : null
              }))
            }
          }
        },
        publishing: {
          on: {
            "sync.requested": { actions: "recordRequest" },
            "result.applied": [
              {
                guard: "publishedCycleFailed",
                target: "retrying",
                actions: "acknowledgeFailure"
              },
              {
                guard: "publishedCycleSucceededWithNewerRequest",
                target: "syncing",
                actions: "acknowledgeSuccessAndBeginNext"
              },
              {
                guard: "isPublishedCycle",
                target: "idle",
                actions: "acknowledgeSuccess"
              }
            ]
          }
        },
        retrying: {
          on: {
            "sync.requested": { actions: "recordRequest" }
          },
          after: {
            retryBackoff: {
              target: "syncing",
              actions: "beginCycle"
            }
          }
        }
      }
    }
  }
});
