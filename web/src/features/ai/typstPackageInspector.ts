import {
  isAiWorkspaceToolExecution,
  type AiTypstPackageToolRequest,
  type AiWorkspaceToolExecution
} from "@/features/ai/toolContract";
import type {
  TypstPackageInspectorCancel,
  TypstPackageInspectorExecute,
  TypstPackageInspectorResponse
} from "@/features/ai/typstPackageInspectorProtocol";
import type { TypstPackageSource } from "@/lib/typstUniverse";

type PendingInspection = {
  tool: AiTypstPackageToolRequest["tool"];
  resolve: (execution: AiWorkspaceToolExecution) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | null;
};

export interface AiTypstPackageInspector {
  execute(
    request: AiTypstPackageToolRequest,
    signal?: AbortSignal
  ): Promise<AiWorkspaceToolExecution>;
  dispose(): void;
}

function cancelled(): AiWorkspaceToolExecution {
  return {
    outcome: "error",
    error: {
      code: "workspace_request_cancelled",
      message: "The Typst package inspection was cancelled."
    }
  };
}

function unavailable(): AiWorkspaceToolExecution {
  return {
    outcome: "error",
    error: {
      code: "typst_package_internal_error",
      message: "The Typst package inspector is unavailable."
    }
  };
}

export class BrowserTypstPackageInspector implements AiTypstPackageInspector {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingInspection>();
  private disposed = false;

  constructor(private readonly source: TypstPackageSource) {}

  execute(request: AiTypstPackageToolRequest, signal?: AbortSignal) {
    if (this.disposed) return Promise.resolve(unavailable());
    if (signal?.aborted) return Promise.resolve(cancelled());
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<AiWorkspaceToolExecution>((resolve) => {
      const abort = signal
        ? () => {
            const pending = this.finish(id);
            if (!pending) return;
            const message: TypstPackageInspectorCancel = { kind: "cancel", id };
            worker.postMessage(message);
            pending.resolve(cancelled());
          }
        : null;
      if (abort) signal!.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { tool: request.tool, resolve, signal, abort });
      if (signal?.aborted) {
        abort?.();
        return;
      }
      const message: TypstPackageInspectorExecute = {
        kind: "execute",
        id,
        source: this.source,
        request
      };
      worker.postMessage(message);
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.pending.keys()]) this.finish(id)?.resolve(cancelled());
  }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("./typstPackageInspector.worker.ts", import.meta.url),
      { type: "module", name: "typst-package-inspector" }
    );
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleWorkerFailure);
    worker.addEventListener("messageerror", this.handleWorkerFailure);
    this.worker = worker;
    return worker;
  }

  private readonly handleMessage = (event: MessageEvent<TypstPackageInspectorResponse>) => {
    const message = event.data;
    if (!message || !Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    const execution = isAiWorkspaceToolExecution(pending.tool, message.execution)
      ? message.execution
      : unavailable();
    this.finish(message.id)?.resolve(execution);
  };

  private readonly handleWorkerFailure = () => {
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.pending.keys()]) this.finish(id)?.resolve(unavailable());
  };

  private finish(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.abort && pending.signal) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    return pending;
  }
}
