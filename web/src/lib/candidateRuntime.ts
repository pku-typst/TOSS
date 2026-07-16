type DisposableRuntime = {
  dispose: () => void;
};

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Serializes authoritative candidate checks without inheriting live preview's
 * latest-value-wins scheduling semantics. An active cancellation invalidates
 * the isolated runtime; queued cancellations never disturb active work.
 */
export class CandidateRuntimeScheduler<Runtime extends DisposableRuntime> {
  private runtime: Runtime | null = null;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(
    private readonly createRuntime: () => Runtime,
    private readonly idleMilliseconds: number,
  ) {}

  run<Result>(
    operation: (runtime: Runtime) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (signal?.aborted) return Promise.reject(abortError());
    this.clearIdleTimer();
    this.pending += 1;

    let activeRuntime: Runtime | null = null;
    let settled = false;
    let resolveResult!: (result: Result) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      rejectResult(abortError());
      if (activeRuntime) {
        try {
          this.invalidate(activeRuntime);
        } catch {
          // The rejected caller remains authoritative even if teardown fails.
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const execute = this.tail.then(async () => {
      if (settled || signal?.aborted) return;
      try {
        const runtime = this.acquire();
        activeRuntime = runtime;
        const value = await operation(runtime);
        if (settled) return;
        if (signal?.aborted) {
          settled = true;
          rejectResult(abortError());
          return;
        }
        settled = true;
        resolveResult(value);
      } catch (error) {
        if (settled) return;
        settled = true;
        rejectResult(signal?.aborted ? abortError() : error);
      } finally {
        activeRuntime = null;
      }
    });
    this.tail = execute.catch(() => undefined);
    const finished = () => {
      signal?.removeEventListener("abort", onAbort);
      this.pending -= 1;
      if (this.pending === 0) this.scheduleIdleDisposal();
    };
    void execute.then(finished, finished);
    return result;
  }

  private acquire() {
    this.runtime ??= this.createRuntime();
    return this.runtime;
  }

  private invalidate(runtime: Runtime) {
    if (this.runtime === runtime) this.runtime = null;
    runtime.dispose();
  }

  private clearIdleTimer() {
    if (this.idleTimer === null) return;
    globalThis.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleDisposal() {
    this.clearIdleTimer();
    const selected = this.runtime;
    if (!selected) return;
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      if (this.pending !== 0 || this.runtime !== selected) return;
      this.runtime = null;
      selected.dispose();
    }, this.idleMilliseconds);
  }
}
