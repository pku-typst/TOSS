import { createActor, waitFor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDelta } from "@/pages/workspace/loaders";
import {
  WORKSPACE_DELTA_INITIAL_RETRY_MS,
  workspaceDeltaMachine,
  type WorkspaceDeltaJob,
  type WorkspaceDeltaRequest
} from "@/pages/workspace/workspaceDeltaActor";

function request(afterDocumentsChangeSequence: number | null): WorkspaceDeltaRequest {
  return {
    projectId: "project-a",
    projectType: "typst",
    latexEngine: "xetex",
    entryFilePath: "main.typ",
    afterDocumentsChangeSequence
  };
}

function job(
  afterDocumentsChangeSequence: number | null,
  sessionGeneration = "session-a",
): WorkspaceDeltaJob {
  return {
    sessionGeneration,
    request: request(afterDocumentsChangeSequence),
  };
}

function delta(documentsChangeSequence: number): WorkspaceDelta {
  return {
    projectType: "typst",
    latexEngine: "xetex",
    entryFilePath: "main.typ",
    settingsRevision: 0,
    nodes: [{ path: "main.typ", kind: "file" }],
    contentEpoch: 3,
    documents: { "main.typ": "updated" },
    documentIdentities: {
      "main.typ": {
        id: "document-a",
        pathRevision: 0,
        collaborationRevision: 0
      }
    },
    documentsChangeSequence,
    assetMeta: {}
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("workspaceDeltaMachine", () => {
  it("stays idle until an event requests synchronization", async () => {
    const load = vi.fn().mockResolvedValue(delta(1));
    const actor = createActor(workspaceDeltaMachine, {
      input: { load }
    }).start();

    actor.send({ type: "configure", job: job(null) });
    await Promise.resolve();
    expect(actor.getSnapshot().matches({ enabled: "idle" })).toBe(true);
    expect(load).not.toHaveBeenCalled();

    actor.send({ type: "sync.requested" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" })
    );
    expect(load).toHaveBeenCalledOnce();

    const completed = actor.getSnapshot().context.completed;
    actor.send({ type: "result.applied", cycle: completed?.cycle ?? -1 });
    expect(actor.getSnapshot().matches({ enabled: "idle" })).toBe(true);
    expect(actor.getSnapshot().context.settledTicket).toBe(1);
    actor.stop();
  });

  it("coalesces in-flight invalidations into one follow-up load", async () => {
    const first = deferred<WorkspaceDelta>();
    const load = vi
      .fn<(next: WorkspaceDeltaRequest) => Promise<WorkspaceDelta>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(delta(2));
    const actor = createActor(workspaceDeltaMachine, {
      input: { load }
    }).start();
    const initial = job(null);
    const updated = job(1);

    actor.send({ type: "configure", job: initial });
    actor.send({ type: "sync.requested" });
    actor.send({ type: "configure", job: updated });
    actor.send({ type: "sync.requested" });
    actor.send({ type: "sync.requested" });
    expect(load).toHaveBeenCalledOnce();

    first.resolve(delta(1));
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" })
    );
    const firstCycle = actor.getSnapshot().context.completed?.cycle ?? -1;
    actor.send({ type: "result.applied", cycle: firstCycle });

    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" }) &&
      snapshot.context.completed?.cycle === 2
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, initial.request);
    expect(load).toHaveBeenNthCalledWith(2, updated.request);
    expect(actor.getSnapshot().context.settledTicket).toBe(1);
    actor.stop();
  });

  it("keeps a failed invalidation dirty until a retry succeeds", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<(next: WorkspaceDeltaRequest) => Promise<WorkspaceDelta>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(delta(2));
    const actor = createActor(workspaceDeltaMachine, {
      input: { load }
    }).start();
    actor.send({ type: "configure", job: job(null) });
    actor.send({ type: "sync.requested" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" })
    );
    const failedCycle = actor.getSnapshot().context.completed?.cycle ?? -1;
    actor.send({ type: "result.applied", cycle: failedCycle });
    expect(actor.getSnapshot().context.settledTicket).toBe(0);
    expect(actor.getSnapshot().matches({ enabled: "retrying" })).toBe(true);

    await vi.advanceTimersByTimeAsync(WORKSPACE_DELTA_INITIAL_RETRY_MS);
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" }) &&
      snapshot.context.completed?.result.status === "success"
    );
    const successfulCycle = actor.getSnapshot().context.completed?.cycle ?? -1;
    actor.send({ type: "result.applied", cycle: successfulCycle });
    expect(actor.getSnapshot().context.settledTicket).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    actor.stop();
    vi.useRealTimers();
  });

  it("cancels publication when synchronization is disabled", async () => {
    const pending = deferred<WorkspaceDelta>();
    const actor = createActor(workspaceDeltaMachine, {
      input: { load: () => pending.promise }
    }).start();

    actor.send({ type: "configure", job: job(null) });
    actor.send({ type: "sync.requested" });
    actor.send({ type: "disable" });
    pending.resolve(delta(1));
    await Promise.resolve();

    expect(actor.getSnapshot().matches("inactive")).toBe(true);
    expect(actor.getSnapshot().context.completed).toBeNull();
    actor.stop();
  });

  it("discards an in-flight result when the Workspace session changes", async () => {
    const stale = deferred<WorkspaceDelta>();
    const load = vi
      .fn<(next: WorkspaceDeltaRequest) => Promise<WorkspaceDelta>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(delta(2));
    const actor = createActor(workspaceDeltaMachine, {
      input: { load },
    }).start();

    actor.send({ type: "configure", job: job(null, "session-a") });
    actor.send({ type: "sync.requested" });
    actor.send({ type: "configure", job: job(null, "session-b") });
    stale.resolve(delta(1));
    await Promise.resolve();

    expect(actor.getSnapshot().matches({ enabled: "idle" })).toBe(true);
    expect(actor.getSnapshot().context.completed).toBeNull();

    actor.send({ type: "sync.requested" });
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ enabled: "publishing" }),
    );
    expect(actor.getSnapshot().context.completed?.job.sessionGeneration).toBe(
      "session-b",
    );
    actor.stop();
  });
});
