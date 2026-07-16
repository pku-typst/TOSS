import type { CompileDiagnostic } from "./typst";
import { validateLatexCompileInput } from "./latexRuntimeUtils";

export type LatexCompileOutput = {
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  compiledAt: number;
};

type WorkerCompileResponse = {
  id: number;
  ok: boolean;
  superseded?: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

type WorkerRuntimeStatus = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
};

type WorkerMessage = WorkerCompileResponse | WorkerRuntimeStatus;

export type LatexRuntimeStatus = {
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loadedBytes?: number;
  totalBytes?: number;
};

type CompileOptions = {
  workspaceKey: string;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  coreApiUrl: string;
  appOrigin?: string;
  engine: "pdftex" | "xetex";
};

type PendingCompile = {
  id: number;
  message: Record<string, unknown>;
  resolve: (response: WorkerCompileResponse) => void;
};

export class LatexWorkerRuntime {
  private worker: Worker | null = null;
  private seq = 1;
  private active: PendingCompile | null = null;
  private queued: PendingCompile | null = null;
  private listeners = new Set<(status: LatexRuntimeStatus) => void>();

  private ensureWorker() {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./latex.worker.ts", import.meta.url), {
      type: "module"
    });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const response = event.data;
      if (response && "kind" in response && response.kind === "runtime.status") {
        const status: LatexRuntimeStatus = {
          stage: response.stage,
          loadedBytes: response.loaded_bytes,
          totalBytes: response.total_bytes
        };
        this.notify(status);
        return;
      }
      const compileResponse = response as WorkerCompileResponse;
      if (!this.active || compileResponse.id !== this.active.id) return;
      const completed = this.active;
      this.active = null;
      completed.resolve(compileResponse);
      this.dispatchQueued();
    };
    this.worker.onerror = (event) => {
      const detail =
        event && "message" in event && typeof event.message === "string"
          ? event.message
          : "LaTeX worker crashed";
      this.active?.resolve({ id: this.active.id, ok: false, errors: [detail] });
      this.queued?.resolve({ id: this.queued.id, ok: false, errors: [detail] });
      this.active = null;
      this.queued = null;
      this.worker?.terminate();
      this.worker = null;
      this.notify({ stage: "idle" });
    };
    return this.worker;
  }

  private dispatchQueued() {
    if (this.active || !this.queued || !this.worker) return;
    const next = this.queued;
    this.queued = null;
    this.active = next;
    this.worker.postMessage(next.message);
  }

  private notify(status: LatexRuntimeStatus) {
    for (const listener of this.listeners) listener(status);
  }

  subscribe(listener: (status: LatexRuntimeStatus) => void) {
    this.listeners.add(listener);
    listener({ stage: "idle" });
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose() {
    this.active?.resolve({
      id: this.active.id,
      ok: false,
      errors: ["LaTeX candidate compiler disposed after becoming idle"]
    });
    this.queued?.resolve({
      id: this.queued.id,
      ok: false,
      errors: ["LaTeX candidate compiler disposed after becoming idle"]
    });
    this.active = null;
    this.queued = null;
    this.worker?.terminate();
    this.worker = null;
    this.notify({ stage: "idle" });
  }

  compile(options: CompileOptions): Promise<WorkerCompileResponse> {
    try {
      validateLatexCompileInput(options);
    } catch (error) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: [error instanceof Error ? error.message : "Invalid LaTeX compile input"]
      });
    }
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: ["This browser does not support Worker-based LaTeX preview"]
      });
    }
    const id = this.seq++;
    this.notify({ stage: "compiling" });
    return new Promise<WorkerCompileResponse>((resolve) => {
      const pending: PendingCompile = {
        id,
        resolve,
        message: {
          id,
          entryFilePath: options.entryFilePath,
          documents: options.documents,
          assets: options.assets.map((asset) => ({
            path: asset.path,
            content_base64: asset.contentBase64
          })),
          coreApiUrl: options.coreApiUrl,
          appOrigin: options.appOrigin,
          engine: options.engine
        }
      };
      if (!this.active) {
        this.active = pending;
        worker.postMessage(pending.message);
        return;
      }
      this.queued?.resolve({ id: this.queued.id, ok: false, superseded: true });
      this.queued = pending;
    });
  }
}

const runtime = new LatexWorkerRuntime();
const CANDIDATE_RUNTIME_IDLE_MS = 60_000;
let candidateRuntime: LatexWorkerRuntime | null = null;
let candidateRuntimeIdleTimer: number | null = null;

function activeCandidateRuntime() {
  if (candidateRuntimeIdleTimer !== null) {
    window.clearTimeout(candidateRuntimeIdleTimer);
    candidateRuntimeIdleTimer = null;
  }
  candidateRuntime ??= new LatexWorkerRuntime();
  return candidateRuntime;
}

function releaseCandidateRuntimeWhenIdle(selectedRuntime: LatexWorkerRuntime) {
  if (candidateRuntimeIdleTimer !== null) {
    window.clearTimeout(candidateRuntimeIdleTimer);
  }
  candidateRuntimeIdleTimer = window.setTimeout(() => {
    if (candidateRuntime !== selectedRuntime) return;
    selectedRuntime.dispose();
    candidateRuntime = null;
    candidateRuntimeIdleTimer = null;
  }, CANDIDATE_RUNTIME_IDLE_MS);
}

async function compileLatexWithRuntime(
  selectedRuntime: LatexWorkerRuntime,
  options: CompileOptions,
): Promise<LatexCompileOutput> {
  if (!options.documents.length) {
    return {
      vectorData: null,
      pdfData: null,
      errors: ["Project has no source documents"],
      diagnostics: [],
      compiledAt: Date.now()
    };
  }
  const result = await selectedRuntime.compile(options);
  if (result.superseded) {
    return {
      vectorData: null,
      pdfData: null,
      errors: [],
      diagnostics: [],
      compiledAt: Date.now()
    };
  }
  if (result.ok && result.pdfBytes && result.pdfBytes.byteLength > 0) {
    return {
      vectorData: null,
      pdfData: result.pdfBytes,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now()
    };
  }
  return {
    vectorData: null,
    pdfData: null,
    errors:
      result.errors?.length
        ? result.errors
        : [
            "This browser cannot run LaTeX WASM preview. You can continue editing source and sync via Git for offline compilation."
          ],
    diagnostics: result.diagnostics ?? [],
    compiledAt: Date.now()
  };
}

export function compileLatexClientSide(options: CompileOptions) {
  return compileLatexWithRuntime(runtime, options);
}

/** Keeps Assistant candidate checks independent from the live preview queue. */
export async function compileLatexCandidateClientSide(options: CompileOptions) {
  const selectedRuntime = activeCandidateRuntime();
  try {
    const output = await compileLatexWithRuntime(selectedRuntime, options);
    return { ...output, pdfData: null };
  } finally {
    releaseCandidateRuntimeWhenIdle(selectedRuntime);
  }
}

export function subscribeLatexRuntimeStatus(listener: (status: LatexRuntimeStatus) => void) {
  return runtime.subscribe(listener);
}
