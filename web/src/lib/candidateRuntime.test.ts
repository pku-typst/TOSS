import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateRuntimeScheduler } from "./candidateRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CandidateRuntimeScheduler", () => {
  it("runs every candidate check in FIFO order", async () => {
    const first = deferred<string>();
    const runtime = { dispose: vi.fn() };
    const scheduler = new CandidateRuntimeScheduler(() => runtime, 60_000);
    const events: string[] = [];

    const one = scheduler.run(async () => {
      events.push("first:start");
      const value = await first.promise;
      events.push("first:end");
      return value;
    });
    const two = scheduler.run(async () => {
      events.push("second:start");
      return "two";
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    first.resolve("one");
    await expect(one).resolves.toBe("one");
    await expect(two).resolves.toBe("two");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("rejects queued cancellation without invalidating active work", async () => {
    const first = deferred<void>();
    const runtime = { dispose: vi.fn() };
    const scheduler = new CandidateRuntimeScheduler(() => runtime, 60_000);
    const active = scheduler.run(() => first.promise);
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => undefined);
    const queued = scheduler.run(queuedOperation, controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.dispose).not.toHaveBeenCalled();
    first.resolve();
    await expect(active).resolves.toBeUndefined();
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it("invalidates an active runtime on cancellation and recreates it", async () => {
    const runtimes: Array<{ dispose: ReturnType<typeof vi.fn>; stopped: ReturnType<typeof deferred<void>> }> = [];
    const scheduler = new CandidateRuntimeScheduler(() => {
      const stopped = deferred<void>();
      const runtime = {
        stopped,
        dispose: vi.fn(() => stopped.resolve())
      };
      runtimes.push(runtime);
      return runtime;
    }, 60_000);
    const controller = new AbortController();
    const active = scheduler.run((runtime) => runtime.stopped.promise, controller.signal);

    await vi.waitFor(() => expect(runtimes).toHaveLength(1));
    controller.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(runtimes[0].dispose).toHaveBeenCalledOnce();

    await expect(scheduler.run(async () => "recreated")).resolves.toBe("recreated");
    expect(runtimes).toHaveLength(2);
  });

  it("disposes only after the whole queue becomes idle", async () => {
    vi.useFakeTimers();
    const runtime = { dispose: vi.fn() };
    const scheduler = new CandidateRuntimeScheduler(() => runtime, 100);

    await expect(scheduler.run(async () => "done")).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(99);
    expect(runtime.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
