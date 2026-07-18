import { assign, fromPromise, setup } from "xstate";
import type { LatexCompileOutput } from "@/lib/latex";
import type { CompileDiagnostic, CompileOutput } from "@/lib/typst";
import {
  sameCompilerTarget,
  sameCompileTarget,
  type CompileTarget,
  type CompileWorld,
} from "@/pages/workspace/compileWorld";

export type WorkspaceCompileJob = {
  sessionGeneration: string;
  world: CompileWorld;
  target: CompileTarget;
};

export type WorkspaceCompileOutput = CompileOutput | LatexCompileOutput;

export type TypstMappingState = {
  revision: number;
  world: CompileWorld;
};

export type TypstVectorCompilationArtifact = {
  job: WorkspaceCompileJob;
  data: Uint8Array;
  mapping: TypstMappingState | null;
};

export type PdfCompilationArtifact = {
  job: WorkspaceCompileJob;
  data: Uint8Array;
};

export type CompilationArtifact = {
  job: WorkspaceCompileJob | null;
  vector: TypstVectorCompilationArtifact | null;
  pdf: PdfCompilationArtifact | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
};

type CompilationResult = {
  job: WorkspaceCompileJob;
  output: WorkspaceCompileOutput;
};

type CompilationMachineInput = {
  initialSessionGeneration: string;
  initialDebounceMs: number;
  liveDebounceMs: number;
  compile: (job: WorkspaceCompileJob) => Promise<WorkspaceCompileOutput>;
};

export type CompilationOperationError = {
  operation: "compile" | "pdfExport";
  cause: unknown;
};

type CompilationContext = CompilationMachineInput & {
  sessionGeneration: string;
  job: WorkspaceCompileJob | null;
  lastResult: CompilationResult | null;
  artifact: CompilationArtifact;
  operationError: CompilationOperationError | null;
  noSourceDocuments: boolean;
  warmed: boolean;
};

type CompilationEvent =
  | { type: "session.started"; sessionGeneration: string }
  | { type: "pause" }
  | { type: "empty" }
  | { type: "compile"; job: WorkspaceCompileJob }
  | { type: "preview.error"; job: WorkspaceCompileJob; message: string }
  | {
      type: "export.output";
      job: WorkspaceCompileJob;
      output: WorkspaceCompileOutput;
    }
  | { type: "export.error"; job: WorkspaceCompileJob; error: unknown };

const EMPTY_ARTIFACT: CompilationArtifact = {
  job: null,
  vector: null,
  pdf: null,
  errors: [],
  diagnostics: [],
};

export function sameCompileRequest(
  left: WorkspaceCompileJob | null | undefined,
  right: WorkspaceCompileJob,
) {
  return (
    left?.sessionGeneration === right.sessionGeneration &&
    left.world === right.world &&
    sameCompileTarget(left.target, right.target)
  );
}

/** Compares source/compiler semantics while allowing Typst PDF mode to differ. */
export function sameCompileProduct(
  left: WorkspaceCompileJob | null | undefined,
  right: WorkspaceCompileJob,
) {
  return (
    left?.sessionGeneration === right.sessionGeneration &&
    left.world === right.world &&
    sameCompilerTarget(left.target, right.target)
  );
}

/** Allows the last successful preview to remain visible while its replacement runs. */
export function samePreviewArtifactKind(
  left: WorkspaceCompileJob | null | undefined,
  right: WorkspaceCompileJob,
) {
  return (
    left?.sessionGeneration === right.sessionGeneration &&
    left.target.kind === right.target.kind
  );
}

export function selectCompilationArtifacts(
  artifact: CompilationArtifact,
  job: WorkspaceCompileJob,
) {
  const current = sameCompileProduct(artifact.job, job) ? artifact : null;
  const vector = samePreviewArtifactKind(artifact.vector?.job, job)
    ? artifact.vector
    : null;
  const pdf = samePreviewArtifactKind(artifact.pdf?.job, job)
    ? artifact.pdf
    : null;
  const vectorCurrent = !!vector && sameCompileProduct(vector.job, job);
  const pdfCurrent = !!pdf && sameCompileProduct(pdf.job, job);
  return {
    current,
    vector,
    pdf,
    mapping:
      vectorCurrent && vector.mapping?.world === job.world
        ? vector.mapping
        : null,
    vectorOutdated: !!vector && !vectorCurrent,
    pdfOutdated: !!pdf && !pdfCurrent,
  };
}

function artifactFromOutput(
  previous: CompilationArtifact,
  job: WorkspaceCompileJob,
  output: WorkspaceCompileOutput,
): CompilationArtifact {
  const mappingRevision =
    "mappingRevision" in output ? output.mappingRevision : null;
  const mapping =
    output.vectorData && mappingRevision && mappingRevision > 0
      ? {
          revision: mappingRevision,
          world: job.world,
        }
      : null;
  const failed = output.errors.length > 0;
  const retainVector =
    failed && samePreviewArtifactKind(previous.vector?.job, job);
  const hasPdf = !!output.pdfData;
  const retainPdf =
    !hasPdf &&
    ((failed && samePreviewArtifactKind(previous.pdf?.job, job)) ||
      (job.target.kind === "typst" &&
        !job.target.emitPdf &&
        sameCompileProduct(previous.pdf?.job, job)));
  return {
    job,
    vector: output.vectorData
      ? { job, data: output.vectorData, mapping }
      : retainVector
        ? previous.vector
        : null,
    pdf:
      hasPdf && output.pdfData
        ? { job, data: output.pdfData }
        : retainPdf
          ? previous.pdf
          : null,
    errors: output.errors,
    diagnostics: output.diagnostics,
  };
}

const runCompilation = fromPromise<
  CompilationResult,
  {
    job: WorkspaceCompileJob;
    compile: CompilationMachineInput["compile"];
  }
>(async ({ input }) => ({
  job: input.job,
  output: await input.compile(input.job),
}));

/** Owns preview compilation debounce, cancellation, and stale-result policy. */
export const workspaceCompilationMachine = setup({
  types: {
    context: {} as CompilationContext,
    events: {} as CompilationEvent,
    input: {} as CompilationMachineInput,
  },
  actors: { runCompilation },
  delays: {
    compileDebounce: ({ context }) =>
      context.warmed ? context.liveDebounceMs : context.initialDebounceMs,
  },
  guards: {
    compileTargetsCurrentSession: ({ context, event }) =>
      event.type === "compile" &&
      event.job.sessionGeneration === context.sessionGeneration,
    canReuseLastResult: ({ context, event }) =>
      event.type === "compile" &&
      sameCompileRequest(context.lastResult?.job, event.job),
    isCurrentRequest: ({ context, event }) =>
      event.type === "compile" && sameCompileRequest(context.job, event.job),
    isCurrentExport: ({ context, event }) =>
      (event.type === "export.output" || event.type === "export.error") &&
      event.job.sessionGeneration === context.sessionGeneration &&
      sameCompileRequest(context.job, event.job),
  },
  actions: {
    startSession: assign(({ event }) =>
      event.type === "session.started"
        ? {
            sessionGeneration: event.sessionGeneration,
            job: null,
            lastResult: null,
            artifact: EMPTY_ARTIFACT,
            operationError: null,
            noSourceDocuments: false
          }
        : {}
    ),
    requestCompilation: assign(({ event }) => {
      if (event.type !== "compile") return {};
      return {
        job: event.job,
        operationError: null,
        noSourceDocuments: false,
      };
    }),
    restoreLastResult: assign(({ context, event }) => {
      if (event.type !== "compile") return {};
      const lastResult = context.lastResult;
      return {
        job: event.job,
        artifact: lastResult
          ? artifactFromOutput(context.artifact, event.job, lastResult.output)
          : context.artifact,
        operationError: null,
        noSourceDocuments: false,
      };
    }),
    clearForEmptyWorkspace: assign({
      job: null,
      lastResult: null,
      artifact: EMPTY_ARTIFACT,
      operationError: null,
      noSourceDocuments: true,
    }),
  },
}).createMachine({
  id: "workspaceCompilation",
  initial: "paused",
  context: ({ input }) => ({
    ...input,
    sessionGeneration: input.initialSessionGeneration,
    job: null,
    lastResult: null,
    artifact: EMPTY_ARTIFACT,
    operationError: null,
    noSourceDocuments: false,
    warmed: false,
  }),
  on: {
    "session.started": {
      target: ".paused",
      reenter: true,
      actions: "startSession"
    },
    "preview.error": {
      guard: ({ context, event }) =>
        event.job.sessionGeneration === context.sessionGeneration &&
        sameCompileRequest(context.job, event.job),
      actions: assign(({ context, event }) => ({
        artifact: {
          ...context.artifact,
          job: event.job,
          errors: [event.message],
          diagnostics: [],
        },
        operationError: null,
        noSourceDocuments: false,
      })),
    },
    "export.output": {
      guard: "isCurrentExport",
      actions: assign(({ context, event }) => ({
        artifact: {
          ...context.artifact,
          pdf: event.output.pdfData
            ? { job: event.job, data: event.output.pdfData }
            : context.artifact.pdf,
          errors:
            event.output.errors.length > 0
              ? event.output.errors
              : context.artifact.errors,
          diagnostics:
            event.output.errors.length > 0
              ? event.output.diagnostics
              : context.artifact.diagnostics,
        },
        operationError: null,
        noSourceDocuments: false,
      })),
    },
    "export.error": {
      guard: "isCurrentExport",
      actions: assign(({ context, event }) => ({
        artifact: {
          ...context.artifact,
          errors: [],
          diagnostics: [],
        },
        operationError: { operation: "pdfExport", cause: event.error },
        noSourceDocuments: false,
      })),
    },
  },
  states: {
    paused: {
      on: {
        compile: [
          {
            guard: "canReuseLastResult",
            target: "ready",
            actions: "restoreLastResult",
          },
          {
            guard: "compileTargetsCurrentSession",
            target: "debouncing",
            actions: "requestCompilation",
          },
        ],
        empty: {
          target: "empty",
          actions: "clearForEmptyWorkspace",
        },
      },
    },
    empty: {
      on: {
        compile: [
          {
            guard: "canReuseLastResult",
            target: "ready",
            actions: "restoreLastResult",
          },
          {
            guard: "compileTargetsCurrentSession",
            target: "debouncing",
            actions: "requestCompilation",
          },
        ],
        pause: { target: "paused" },
      },
    },
    debouncing: {
      after: {
        compileDebounce: { target: "compiling" },
      },
      on: {
        compile: [
          {
            guard: "isCurrentRequest",
            actions: "requestCompilation",
          },
          {
            guard: "compileTargetsCurrentSession",
            target: "debouncing",
            reenter: true,
            actions: "requestCompilation",
          },
        ],
        pause: { target: "paused" },
        empty: {
          target: "empty",
          actions: "clearForEmptyWorkspace",
        },
      },
    },
    compiling: {
      entry: assign({ warmed: true }),
      invoke: {
        src: "runCompilation",
        input: ({ context }) => {
          if (!context.job) {
            throw new Error("A compilation requires a current job");
          }
          return { job: context.job, compile: context.compile };
        },
        onDone: {
          target: "ready",
          actions: assign(({ context, event }) => ({
            job: event.output.job,
            lastResult: event.output,
            artifact: artifactFromOutput(
              context.artifact,
              event.output.job,
              event.output.output,
            ),
            operationError: null,
            noSourceDocuments: false,
          })),
        },
        onError: {
          target: "failed",
          actions: assign(({ context, event }) => ({
            artifact: {
              ...context.artifact,
              job: context.job,
              vector:
                context.job &&
                samePreviewArtifactKind(
                  context.artifact.vector?.job,
                  context.job,
                )
                  ? context.artifact.vector
                  : null,
              pdf:
                context.job &&
                samePreviewArtifactKind(
                  context.artifact.pdf?.job,
                  context.job,
                )
                  ? context.artifact.pdf
                  : null,
              errors: [],
              diagnostics: [],
            },
            operationError: { operation: "compile", cause: event.error },
            noSourceDocuments: false,
          })),
        },
      },
      on: {
        compile: [
          {
            guard: "isCurrentRequest",
            actions: "requestCompilation",
          },
          {
            guard: "compileTargetsCurrentSession",
            target: "debouncing",
            actions: "requestCompilation",
          },
        ],
        pause: { target: "paused" },
        empty: {
          target: "empty",
          actions: "clearForEmptyWorkspace",
        },
      },
    },
    ready: {
      on: {
        compile: [
          {
            guard: "isCurrentRequest",
            actions: "requestCompilation",
          },
          {
            guard: "canReuseLastResult",
            target: "ready",
            actions: "restoreLastResult",
          },
          {
            guard: "compileTargetsCurrentSession",
            target: "debouncing",
            actions: "requestCompilation",
          },
        ],
        pause: { target: "paused" },
        empty: {
          target: "empty",
          actions: "clearForEmptyWorkspace",
        },
      },
    },
    failed: {
      on: {
        compile: {
          guard: "compileTargetsCurrentSession",
          target: "debouncing",
          actions: "requestCompilation",
        },
        pause: { target: "paused" },
        empty: {
          target: "empty",
          actions: "clearForEmptyWorkspace",
        },
      },
    },
  },
});

type PdfExportMachineInput = {
  initialSessionGeneration: string;
  isCurrent: (job: WorkspaceCompileJob) => boolean;
  generate: (job: WorkspaceCompileJob) => Promise<WorkspaceCompileOutput>;
  onOutput: (job: WorkspaceCompileJob, output: WorkspaceCompileOutput) => void;
  onError: (job: WorkspaceCompileJob, error: unknown) => void;
  download: (bytes: Uint8Array, entryFilePath: string) => void;
};

type PdfExportContext = PdfExportMachineInput & {
  sessionGeneration: string;
  job: WorkspaceCompileJob | null;
};

type PdfExportEvent =
  | { type: "session.started"; sessionGeneration: string }
  | {
      type: "export";
      job: WorkspaceCompileJob;
      cachedPdf: Uint8Array | null;
    };

const generatePdf = fromPromise<
  CompilationResult,
  {
    job: WorkspaceCompileJob;
    generate: PdfExportMachineInput["generate"];
  }
>(async ({ input }) => ({
  job: input.job,
  output: await input.generate(input.job),
}));

/** Keeps PDF generation independent from the live preview compilation lane. */
export const pdfExportMachine = setup({
  types: {
    context: {} as PdfExportContext,
    events: {} as PdfExportEvent,
    input: {} as PdfExportMachineInput,
  },
  actors: { generatePdf },
  guards: {
    hasCachedPdf: ({ context, event }) =>
      event.type === "export" &&
      event.job.sessionGeneration === context.sessionGeneration &&
      context.isCurrent(event.job) &&
      !!event.cachedPdf,
    canGeneratePdf: ({ context, event }) =>
      event.type === "export" &&
      event.job.sessionGeneration === context.sessionGeneration &&
      context.isCurrent(event.job) &&
      event.job.target.kind === "typst",
  },
}).createMachine({
  id: "pdfExport",
  initial: "idle",
  context: ({ input }) => ({
    ...input,
    sessionGeneration: input.initialSessionGeneration,
    job: null
  }),
  on: {
    "session.started": {
      target: ".idle",
      reenter: true,
      actions: assign(({ event }) => ({
        sessionGeneration: event.sessionGeneration,
        job: null
      }))
    }
  },
  states: {
    idle: {
      on: {
        export: [
          {
            guard: "hasCachedPdf",
            actions: ({ context, event }) => {
              if (event.cachedPdf) {
                context.download(event.cachedPdf, event.job.world.entryFilePath);
              }
            },
          },
          {
            guard: "canGeneratePdf",
            target: "generating",
            actions: assign(({ event }) => ({ job: event.job })),
          },
        ],
      },
    },
    generating: {
      invoke: {
        src: "generatePdf",
        input: ({ context }) => {
          if (!context.job) {
            throw new Error(
              "PDF generation requires a current compilation job",
            );
          }
          return { job: context.job, generate: context.generate };
        },
        onDone: {
          target: "idle",
          actions: ({ context, event }) => {
            const { job, output } = event.output;
            if (!context.isCurrent(job)) return;
            context.onOutput(job, output);
            if (output.pdfData && output.errors.length === 0) {
              context.download(output.pdfData, job.world.entryFilePath);
            } else if (output.errors.length === 0) {
              context.onError(job, null);
            }
          },
        },
        onError: {
          target: "idle",
          actions: ({ context, event }) => {
            if (context.job && context.isCurrent(context.job)) {
              context.onError(context.job, event.error);
            }
          },
        },
      },
    },
  },
});
