import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import {
  projectRealtimeMachine,
  type ProjectRealtimeConfig,
  type ProjectRealtimeEvents,
} from "@/pages/workspace/projectRealtimeActor";

function config(): ProjectRealtimeConfig {
  return {
    sessionKey: "project-a:user-a",
    projectId: "project-a",
    userId: "user-a",
    shareToken: null,
    guestSession: null,
  };
}

describe("projectRealtimeMachine", () => {
  it("owns one project control stream and records invalidations", () => {
    const close = vi.fn();
    let callbacks: ProjectRealtimeEvents | undefined;
    const open = vi.fn(
      (_config: ProjectRealtimeConfig, events: ProjectRealtimeEvents) => {
        callbacks = events;
        return { close };
      },
    );
    const actor = createActor(projectRealtimeMachine, {
      input: {
        open,
        onProjectReplaced: vi.fn(),
        onAccessChanged: vi.fn(),
      },
    }).start();

    actor.send({ type: "bind", config: config() });
    callbacks?.onStatusChange("connected");
    callbacks?.onBootstrapDone();
    callbacks?.onWorkspaceChanged({
      scope: "document",
      path: "main.typ",
      document_id: "document-a",
      collaboration_revision: 3,
      change_sequence: 9,
    });
    expect(actor.getSnapshot().context.status).toBe("connected");
    expect(actor.getSnapshot().context.catchUpSequence).toBe(1);
    expect(actor.getSnapshot().context.workspaceChangeSequence).toBe(1);
    expect(actor.getSnapshot().context.documentChanges["main.typ"]).toEqual({
      sequence: 1,
      documentId: "document-a",
      collaborationRevision: 3,
      changeSequence: 9,
    });
    callbacks?.onWorkspaceChanged({
      scope: "document",
      path: "main.typ",
      document_id: "document-a",
      collaboration_revision: 2,
      change_sequence: 8,
    });
    expect(actor.getSnapshot().context.workspaceChangeSequence).toBe(2);
    expect(actor.getSnapshot().context.documentChanges["main.typ"]).toEqual({
      sequence: 1,
      documentId: "document-a",
      collaborationRevision: 3,
      changeSequence: 9,
    });

    actor.send({ type: "bind", config: { ...config() } });
    expect(open).toHaveBeenCalledOnce();
    actor.send({ type: "disable" });
    expect(close).toHaveBeenCalledOnce();
    actor.stop();
  });

  it("closes the stream before invalidating cached authorization", () => {
    const close = vi.fn();
    const onAccessChanged = vi.fn();
    let callbacks: ProjectRealtimeEvents | undefined;
    const actor = createActor(projectRealtimeMachine, {
      input: {
        open: (_config, events) => {
          callbacks = events;
          return { close };
        },
        onProjectReplaced: vi.fn(),
        onAccessChanged,
      },
    }).start();

    actor.send({ type: "bind", config: config() });
    callbacks?.onAccessChanged();

    expect(actor.getSnapshot().matches("accessInvalidated")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(onAccessChanged).toHaveBeenCalledOnce();
    actor.stop();
  });
});
