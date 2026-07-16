import { createActor, waitFor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import type { RevisionTransfer } from "@/lib/api";
import {
  revisionMaterializationMachine,
  type RevisionMaterializationRequest,
  type RevisionTransferLoader
} from "@/pages/workspace/revisionMaterializationActor";

function response(
  revisionId: string,
  overrides: Partial<RevisionTransfer> = {}
): RevisionTransfer {
  return {
    revision_id: revisionId,
    entry_file_path: "main.typ",
    transfer_mode: "full",
    base_anchor: "none",
    base_revision_id: null,
    nodes: [{ path: "main.typ", kind: "file" }],
    documents: [{ path: "main.typ", content: `= ${revisionId}` }],
    deleted_documents: [],
    assets: [],
    deleted_assets: [],
    ...overrides
  };
}

function request(
  revisionId: string,
  sessionGeneration = "session-a"
): RevisionMaterializationRequest {
  return {
    sessionGeneration,
    projectId: "project-a",
    revisionId,
    liveDocs: { "main.typ": "= live" },
    liveAssets: {},
    liveAssetMeta: {}
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("revisionMaterializationMachine", () => {
  it("publishes download progress and the completed artifact", async () => {
    const pending = deferred<RevisionTransfer>();
    const load = vi.fn<RevisionTransferLoader>(
      (_projectId, _revisionId, _options, onProgress) => {
        onProgress({ loadedBytes: 4, totalBytes: 10 });
        return pending.promise;
      }
    );
    const actor = createActor(revisionMaterializationMachine, {
      input: { initialSessionGeneration: "session-a", load }
    }).start();

    actor.send({ type: "open", request: request("revision-a") });
    await waitFor(
      actor,
      (snapshot) => snapshot.context.loading.loadedBytes === 4
    );
    expect(actor.getSnapshot().context.loading).toEqual({
      active: true,
      revisionId: "revision-a",
      loadedBytes: 4,
      totalBytes: 10
    });
    pending.resolve(response("revision-a"));
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));

    expect(load).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.artifact).toMatchObject({
      revisionId: "revision-a",
      documents: { "main.typ": "= revision-a" }
    });
    expect(actor.getSnapshot().context.loading).toEqual({
      active: false,
      revisionId: "revision-a",
      loadedBytes: 0,
      totalBytes: null
    });
    expect(actor.getSnapshot().context.outcome).toEqual({
      status: "success",
      revisionId: "revision-a"
    });
    actor.stop();
  });

  it("falls back to a full transfer when the delta anchor cannot be applied", async () => {
    const load = vi
      .fn<RevisionTransferLoader>()
      .mockResolvedValueOnce(response("base"))
      .mockResolvedValueOnce(
        response("target", {
          transfer_mode: "delta",
          base_anchor: "revision",
          base_revision_id: "unavailable"
        })
      )
      .mockResolvedValueOnce(response("target"));
    const actor = createActor(revisionMaterializationMachine, {
      input: { initialSessionGeneration: "session-a", load }
    }).start();

    actor.send({ type: "open", request: request("base") });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    actor.send({ type: "open", request: request("target") });
    await waitFor(
      actor,
      (snapshot) =>
        snapshot.matches("ready") &&
        snapshot.context.artifact?.revisionId === "target"
    );

    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls[1]?.[2]).toEqual({
      currentRevisionId: "base",
      includeLiveAnchor: true
    });
    expect(load.mock.calls[2]?.[2]).toEqual({ includeLiveAnchor: false });
    expect(actor.getSnapshot().context.artifact?.documents).toEqual({
      "main.typ": "= target"
    });
    actor.stop();
  });

  it("ignores a superseded request even if it resolves last", async () => {
    const first = deferred<RevisionTransfer>();
    const load = vi
      .fn<RevisionTransferLoader>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(response("second"));
    const actor = createActor(revisionMaterializationMachine, {
      input: { initialSessionGeneration: "session-a", load }
    }).start();

    actor.send({ type: "open", request: request("first") });
    actor.send({ type: "open", request: request("second") });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    first.resolve(response("first"));
    await Promise.resolve();

    expect(actor.getSnapshot().context.artifact?.revisionId).toBe("second");
    expect(actor.getSnapshot().context.outcome).toEqual({
      status: "success",
      revisionId: "second"
    });
    actor.stop();
  });

  it("cancels loading and discards the artifact when cleared", async () => {
    const pending = deferred<RevisionTransfer>();
    const actor = createActor(revisionMaterializationMachine, {
      input: {
        initialSessionGeneration: "session-a",
        load: () => pending.promise
      }
    }).start();

    actor.send({ type: "open", request: request("revision-a") });
    actor.send({ type: "clear" });
    pending.resolve(response("revision-a"));
    await Promise.resolve();

    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(actor.getSnapshot().context.artifact).toBeNull();
    expect(actor.getSnapshot().context.loading.active).toBe(false);
    actor.stop();
  });

  it("cancels and hides an artifact when the Workspace session changes", async () => {
    const pending = deferred<RevisionTransfer>();
    const load = vi
      .fn<RevisionTransferLoader>()
      .mockResolvedValueOnce(response("shared-revision"))
      .mockImplementationOnce(() => pending.promise);
    const actor = createActor(revisionMaterializationMachine, {
      input: { initialSessionGeneration: "session-a", load }
    }).start();

    actor.send({ type: "open", request: request("shared-revision") });
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(actor.getSnapshot().context.artifact?.sessionGeneration).toBe(
      "session-a"
    );

    actor.send({
      type: "session.started",
      sessionGeneration: "session-b"
    });
    actor.send({
      type: "open",
      request: request("shared-revision", "session-b")
    });
    expect(actor.getSnapshot().context.artifact).toBeNull();

    actor.send({
      type: "open",
      request: request("stale-revision", "session-a")
    });
    pending.resolve(response("shared-revision"));
    await waitFor(actor, (snapshot) => snapshot.matches("ready"));
    expect(actor.getSnapshot().context.artifact).toMatchObject({
      sessionGeneration: "session-b",
      revisionId: "shared-revision"
    });
    actor.stop();
  });
});
