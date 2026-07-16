import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatexWorkerRuntime } from "./latex";

type WorkerResponse =
  | {
      id: number;
      ok: boolean;
      errors?: string[];
    }
  | {
      kind: "runtime.status";
      stage: "downloading-compiler" | "compiling" | "ready" | "idle";
      loaded_bytes?: number;
      total_bytes?: number;
    };

class FakeCompileWorker {
  static instances: FakeCompileWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor() {
    FakeCompileWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: WorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<WorkerResponse>);
  }

  crash(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const compileOptions = {
  workspaceKey: "project-1:live",
  entryFilePath: "main.tex",
  documents: [{ path: "main.tex", content: "\\documentclass{article}" }],
  assets: [],
  coreApiUrl: "",
  appOrigin: "https://example.test",
  engine: "pdftex" as const
};

beforeEach(() => {
  FakeCompileWorker.instances = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("Worker", FakeCompileWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LatexWorkerRuntime", () => {
  it("forwards compiler download byte progress to subscribers", () => {
    const runtime = new LatexWorkerRuntime();
    const statuses = vi.fn();
    runtime.subscribe(statuses);
    void runtime.compile(compileOptions);
    const worker = FakeCompileWorker.instances[0];

    worker?.emit({
      kind: "runtime.status",
      stage: "downloading-compiler",
      loaded_bytes: 24,
      total_bytes: 96
    });

    expect(statuses).toHaveBeenLastCalledWith({
      stage: "downloading-compiler",
      loadedBytes: 24,
      totalBytes: 96
    });
  });

  it("keeps only the newest compile queued behind an active compile", async () => {
    const runtime = new LatexWorkerRuntime();
    const first = runtime.compile(compileOptions);
    const second = runtime.compile({ ...compileOptions, entryFilePath: "second.tex" });
    const third = runtime.compile({ ...compileOptions, entryFilePath: "third.tex" });
    const worker = FakeCompileWorker.instances[0];

    await expect(second).resolves.toMatchObject({ id: 2, ok: false, superseded: true });
    expect(worker?.messages.map((message) => message.id)).toEqual([1]);

    worker?.emit({ id: 1, ok: true });
    await expect(first).resolves.toMatchObject({ id: 1, ok: true });
    expect(worker?.messages.map((message) => message.id)).toEqual([1, 3]);

    worker?.emit({ id: 3, ok: true });
    await expect(third).resolves.toMatchObject({ id: 3, ok: true });
  });

  it("fails active and queued work and recreates the worker after a crash", async () => {
    const runtime = new LatexWorkerRuntime();
    const first = runtime.compile(compileOptions);
    const second = runtime.compile({ ...compileOptions, entryFilePath: "latest.tex" });
    const failedWorker = FakeCompileWorker.instances[0];
    failedWorker?.crash("worker failed");

    await expect(first).resolves.toMatchObject({ ok: false, errors: ["worker failed"] });
    await expect(second).resolves.toMatchObject({ ok: false, errors: ["worker failed"] });
    expect(failedWorker?.terminated).toBe(true);

    const retry = runtime.compile(compileOptions);
    expect(FakeCompileWorker.instances).toHaveLength(2);
    FakeCompileWorker.instances[1]?.emit({ id: 3, ok: true });
    await expect(retry).resolves.toMatchObject({ id: 3, ok: true });
  });

  it("rejects duplicate compile paths before creating a worker", async () => {
    const runtime = new LatexWorkerRuntime();
    const result = runtime.compile({
      ...compileOptions,
      assets: [{ path: "/main.tex", contentBase64: "aGVsbG8=" }]
    });

    await expect(result).resolves.toMatchObject({
      id: -1,
      ok: false,
      errors: ["Duplicate LaTeX workspace path"]
    });
    expect(FakeCompileWorker.instances).toHaveLength(0);
  });
});
