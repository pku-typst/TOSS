import { createActor, waitFor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import {
  pdfExportMachine,
  sameCompileProduct,
  workspaceCompilationMachine,
  type WorkspaceCompileJob,
  type WorkspaceCompileOutput,
} from "@/pages/workspace/compilationActor";
import {
  CompileWorldProjector,
  createCompileTarget,
  type CompileTarget,
  type CompileWorld,
} from "@/pages/workspace/compileWorld";

function world(
  content: string,
  scope = "project-a:live",
  projectType: "typst" | "latex" = "typst",
): CompileWorld {
  const suffix = projectType === "typst" ? "typ" : "tex";
  return new CompileWorldProjector().project({
    scope,
    projectType,
    entryFilePath: `main.${suffix}`,
    documents: { [`main.${suffix}`]: content },
    assets: {},
  });
}

function job(
  compileWorld: CompileWorld,
  target: CompileTarget = createCompileTarget("typst", "xetex", false),
  sessionGeneration = "session-a",
): WorkspaceCompileJob {
  return { sessionGeneration, world: compileWorld, target };
}

function output(
  marker: number,
  pdfData: Uint8Array | null = null,
): WorkspaceCompileOutput {
  return {
    vectorData: new Uint8Array([marker]),
    vectorMode: "full",
    pdfData,
    errors: [],
    diagnostics: [],
    compiledAt: marker,
    mappingRevision: marker,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("workspaceCompilationMachine", () => {
  it("cancels stale results and publishes only the latest compilation", async () => {
    vi.useFakeTimers();
    const first = deferred<WorkspaceCompileOutput>();
    const second = deferred<WorkspaceCompileOutput>();
    const firstJob = job(world("one"));
    const secondJob = job(world("two"));
    const compile = vi.fn((next: WorkspaceCompileJob) =>
      next.world === firstJob.world ? first.promise : second.promise,
    );
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 120,
        compile,
      },
    }).start();

    actor.send({ type: "compile", job: firstJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("compiling"));
    actor.send({ type: "compile", job: secondJob });
    await vi.advanceTimersByTimeAsync(120);
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));

    second.resolve(output(2));
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(actor.getSnapshot().context.artifact.vectorData).toEqual(
      new Uint8Array([2]),
    );

    first.resolve(output(1));
    await Promise.resolve();
    expect(actor.getSnapshot().context.artifact.vectorData).toEqual(
      new Uint8Array([2]),
    );
    actor.stop();
    vi.useRealTimers();
  });

  it("reuses the completed artifact when an unchanged preview resumes", async () => {
    vi.useFakeTimers();
    const compile = vi.fn(async () => output(7));
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 120,
        compile,
      },
    }).start();
    const compileWorld = world("same");
    const firstJob = job(compileWorld);
    const equivalentJob = job(compileWorld);

    actor.send({ type: "compile", job: firstJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "pause" });
    actor.send({ type: "compile", job: equivalentJob });

    expect(actor.getSnapshot().matches("ready")).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    actor.stop();
    vi.useRealTimers();
  });

  it("does not reuse identical source text from another World scope", async () => {
    vi.useFakeTimers();
    const compile = vi.fn(async () => output(7));
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 0,
        compile,
      },
    }).start();

    actor.send({ type: "compile", job: job(world("same", "project-a:live")) });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "compile", job: job(world("same", "project-b:live")) });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    expect(compile).toHaveBeenCalledTimes(2);
    actor.stop();
    vi.useRealTimers();
  });

  it("does not retain a PDF produced by another compiler target", async () => {
    vi.useFakeTimers();
    const compileWorld = world("same", "project-a:live", "latex");
    const firstJob = job(
      compileWorld,
      createCompileTarget("latex", "xetex", false),
    );
    const secondJob = job(
      compileWorld,
      createCompileTarget("latex", "pdftex", false),
    );
    const compile = vi.fn(async (next: WorkspaceCompileJob) =>
      next.target.kind === "latex" && next.target.engine === "xetex"
        ? output(1, new Uint8Array([1]))
        : output(2),
    );
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 0,
        compile,
      },
    }).start();

    actor.send({ type: "compile", job: firstJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(actor.getSnapshot().context.artifact.pdf?.data).toEqual(
      new Uint8Array([1]),
    );

    actor.send({ type: "compile", job: secondJob });
    await vi.advanceTimersByTimeAsync(120);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(actor.getSnapshot().context.artifact.pdf).toBeNull();
    actor.stop();
    vi.useRealTimers();
  });

  it("retains a matching Typst PDF when only emission mode changes", async () => {
    vi.useFakeTimers();
    const compileWorld = world("same");
    const pdfJob = job(
      compileWorld,
      createCompileTarget("typst", "xetex", true),
    );
    const vectorJob = job(
      compileWorld,
      createCompileTarget("typst", "xetex", false),
    );
    const compile = vi
      .fn()
      .mockResolvedValueOnce(output(1, new Uint8Array([1])))
      .mockResolvedValueOnce(output(2));
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 0,
        compile,
      },
    }).start();

    actor.send({ type: "compile", job: pdfJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "compile", job: vectorJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) =>
      snapshot.matches("ready") && snapshot.context.artifact.job === vectorJob,
    );

    expect(actor.getSnapshot().context.artifact.pdf?.data).toEqual(
      new Uint8Array([1]),
    );
    actor.stop();
    vi.useRealTimers();
  });

  it("ignores PDF export results from a superseded World", async () => {
    vi.useFakeTimers();
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 0,
        compile: async () => output(2),
      },
    }).start();
    const currentJob = job(world("current"));
    actor.send({ type: "compile", job: currentJob });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    const staleJob = job(world("stale"));
    actor.send({
      type: "export.output",
      job: staleJob,
      output: output(9, new Uint8Array([9])),
    });
    actor.send({ type: "export.error", job: staleJob, error: "stale" });
    expect(actor.getSnapshot().context.artifact.pdf).toBeNull();
    expect(actor.getSnapshot().context.operationError).toBeNull();

    const currentPdf = new Uint8Array([2]);
    actor.send({
      type: "export.output",
      job: currentJob,
      output: output(2, currentPdf),
    });
    expect(actor.getSnapshot().context.artifact.pdf?.data).toBe(currentPdf);
    actor.stop();
    vi.useRealTimers();
  });

  it("cancels compilation and clears artifacts for a new Workspace session", async () => {
    vi.useFakeTimers();
    const stale = deferred<WorkspaceCompileOutput>();
    const compile = vi.fn(() => stale.promise);
    const actor = createActor(workspaceCompilationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        initialDebounceMs: 0,
        liveDebounceMs: 0,
        compile,
      },
    }).start();

    actor.send({ type: "compile", job: job(world("old")) });
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(actor, (snapshot) => snapshot.matches("compiling"));
    actor.send({
      type: "session.started",
      sessionGeneration: "session-b",
    });

    expect(actor.getSnapshot().matches("paused")).toBe(true);
    expect(actor.getSnapshot().context.artifact.job).toBeNull();
    actor.send({
      type: "compile",
      job: job(world("stale"), undefined, "session-a"),
    });
    expect(actor.getSnapshot().matches("paused")).toBe(true);

    stale.resolve(output(1));
    await Promise.resolve();
    expect(actor.getSnapshot().context.artifact.vectorData).toBeNull();
    actor.stop();
    vi.useRealTimers();
  });
});

describe("pdfExportMachine", () => {
  it("uses a cached PDF without starting another compilation", () => {
    const generate = vi.fn(async () => output(1));
    const download = vi.fn();
    const actor = createActor(pdfExportMachine, {
      input: {
        initialSessionGeneration: "session-a",
        isCurrent: () => true,
        generate,
        onOutput: vi.fn(),
        onError: vi.fn(),
        download,
      },
    }).start();
    const cachedPdf = new Uint8Array([3, 4]);

    actor.send({ type: "export", job: job(world("cached")), cachedPdf });

    expect(generate).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(cachedPdf, "main.typ");
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    actor.stop();
  });

  it("serializes PDF generation and publishes its output", async () => {
    const pdfData = new Uint8Array([8, 9]);
    const generated = output(8, pdfData);
    const generate = vi.fn(async () => generated);
    const onOutput = vi.fn();
    const download = vi.fn();
    const actor = createActor(pdfExportMachine, {
      input: {
        initialSessionGeneration: "session-a",
        isCurrent: () => true,
        generate,
        onOutput,
        onError: vi.fn(),
        download,
      },
    }).start();
    const compileJob = job(world("export"));

    actor.send({ type: "export", job: compileJob, cachedPdf: null });
    actor.send({ type: "export", job: compileJob, cachedPdf: null });
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(compileJob, generated);
    expect(download).toHaveBeenCalledWith(pdfData, "main.typ");
    actor.stop();
  });

  it("cancels an export when the Workspace session changes", async () => {
    const pending = deferred<WorkspaceCompileOutput>();
    const download = vi.fn();
    const actor = createActor(pdfExportMachine, {
      input: {
        initialSessionGeneration: "session-a",
        isCurrent: () => true,
        generate: () => pending.promise,
        onOutput: vi.fn(),
        onError: vi.fn(),
        download,
      },
    }).start();

    actor.send({
      type: "export",
      job: job(world("old")),
      cachedPdf: null,
    });
    await waitFor(actor, (snapshot) => snapshot.matches("generating"));
    actor.send({
      type: "session.started",
      sessionGeneration: "session-b",
    });
    pending.resolve(output(4, new Uint8Array([4])));
    await Promise.resolve();

    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(download).not.toHaveBeenCalled();
    actor.stop();
  });

  it("drops a generated PDF when its World is no longer current", async () => {
    const pending = deferred<WorkspaceCompileOutput>();
    const firstJob = job(world("first"));
    let currentJob = firstJob;
    const onOutput = vi.fn();
    const download = vi.fn();
    const actor = createActor(pdfExportMachine, {
      input: {
        initialSessionGeneration: "session-a",
        isCurrent: (candidate) => sameCompileProduct(currentJob, candidate),
        generate: () => pending.promise,
        onOutput,
        onError: vi.fn(),
        download,
      },
    }).start();

    actor.send({ type: "export", job: firstJob, cachedPdf: null });
    await waitFor(actor, (snapshot) => snapshot.matches("generating"));
    currentJob = job(world("second"));
    pending.resolve(output(4, new Uint8Array([4])));
    await waitFor(actor, (snapshot) => snapshot.matches("idle"));

    expect(onOutput).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    actor.stop();
  });
});
