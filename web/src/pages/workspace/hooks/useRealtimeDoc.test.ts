// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { coreCollaborationBackend } from "@/collaboration/coreCollaborationBackend";
import { ApplicationRuntimeProvider } from "@/composition/applicationRuntime";
import { createTestApplicationRuntime } from "@/testSupport/applicationRuntime";
import { useRealtimeDoc } from "@/pages/workspace/hooks/useRealtimeDoc";
import {
  openRealtimeDocumentSession,
  type RealtimeDocumentConfig,
  type RealtimeDocumentSession,
  type RealtimeDocumentSessionEvents
} from "@/pages/workspace/realtimeDocumentActor";

vi.mock("@/pages/workspace/realtimeDocumentActor", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/pages/workspace/realtimeDocumentActor")
  >();
  return {
    ...actual,
    openRealtimeDocumentSession: vi.fn()
  };
});

type OpenedSession = {
  config: RealtimeDocumentConfig;
  events: RealtimeDocumentSessionEvents;
  session: RealtimeDocumentSession;
  close: ReturnType<typeof vi.fn>;
};

const opened: OpenedSession[] = [];

function wrapper({ children }: PropsWithChildren) {
  return createElement(
    ApplicationRuntimeProvider,
    {
      runtime: createTestApplicationRuntime({
        collaboration: coreCollaborationBackend,
      }),
      children,
    },
  );
}

beforeEach(() => {
  opened.length = 0;
  vi.mocked(openRealtimeDocumentSession).mockReset();
  vi.mocked(openRealtimeDocumentSession).mockImplementation(
    (config, events) => {
      const ydoc = new Y.Doc();
      const close = vi.fn(() => ydoc.destroy());
      const session: RealtimeDocumentSession = {
        ydoc,
        ytext: ydoc.getText("main"),
        commands: {
          sendCursor: vi.fn(),
          reconnectNow: vi.fn(),
          sendSyncSnapshot: vi.fn()
        },
        close
      };
      opened.push({ config, events, session, close });
      return session;
    }
  );
});

describe("useRealtimeDoc", () => {
  it("switches Yjs subscriptions without exposing the previous document", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ activePath, docs }) =>
        useRealtimeDoc({
          projectId: "project-a",
          activePath,
          docs,
          documentIdentities: {
            "one.typ": {
              id: "document-one",
              pathRevision: 0,
              collaborationRevision: 0
            },
            "two.typ": {
              id: "document-two",
              pathRevision: 0,
              collaborationRevision: 0
            }
          },
          workspaceLoaded: true,
          isRevisionMode: false,
          canWrite: true,
          effectiveUserId: "user-a",
          effectiveUserName: "Ada"
        }),
      {
        wrapper,
        initialProps: {
          activePath: "one.typ",
          docs: { "one.typ": "one", "two.typ": "two" }
        }
      }
    );
    await waitFor(() => expect(opened).toHaveLength(1));
    const first = opened[0];
    expect(first).toBeDefined();

    act(() => {
      first?.session.ytext.insert(0, "one");
      first?.events.onReady("one");
    });
    await waitFor(() => expect(result.current.realtimeDocReady).toBe(true));
    expect(result.current.docText).toBe("one");

    rerender({
      activePath: "two.typ",
      docs: { "one.typ": "one", "two.typ": "two" }
    });
    expect(result.current.realtimeDocReady).toBe(false);
    expect(result.current.docText).toBe("");
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(first?.close).toHaveBeenCalledOnce();

    act(() => first?.events.onReady("stale"));
    expect(result.current.realtimeDocReady).toBe(false);
    expect(result.current.docText).toBe("");

    const second = opened[1];
    act(() => {
      second?.session.ytext.insert(0, "two");
      second?.events.onReady("two");
    });
    await waitFor(() => expect(result.current.realtimeDocReady).toBe(true));
    expect(result.current.docText).toBe("two");

    act(() => {
      result.current.applyDocumentDeltas([
        { from: 3, to: 3, insert: "!" }
      ]);
    });
    expect(result.current.docText).toBe("two!");

    let replaceOutcome: ReturnType<typeof result.current.replaceActiveDocumentText> | undefined;
    act(() => {
      replaceOutcome = result.current.replaceActiveDocumentText("two.typ", "two!", "two updated");
    });
    expect(replaceOutcome).toBe("applied");
    expect(result.current.docText).toBe("two updated");
    expect(result.current.replaceActiveDocumentText("two.typ", "two!", "stale edit"))
      .toBe("stale");
    expect(result.current.replaceActiveDocumentText("one.typ", "one", "wrong path"))
      .toBe("unavailable");

    unmount();
    expect(second?.close).toHaveBeenCalledOnce();
  });

  it("rebinds when an authoritative overwrite advances collaboration revision", async () => {
    const { rerender, unmount } = renderHook(
      ({ collaborationRevision, content }) =>
        useRealtimeDoc({
          projectId: "project-a",
          activePath: "main.typ",
          docs: { "main.typ": content },
          documentIdentities: {
            "main.typ": {
              id: "document-main",
              pathRevision: 0,
              collaborationRevision
            }
          },
          workspaceLoaded: true,
          isRevisionMode: false,
          canWrite: true,
          effectiveUserId: "user-a",
          effectiveUserName: "Ada"
        }),
      {
        wrapper,
        initialProps: { collaborationRevision: 0, content: "before" }
      }
    );
    await waitFor(() => expect(opened).toHaveLength(1));

    rerender({ collaborationRevision: 1, content: "after" });
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[0]?.close).toHaveBeenCalledOnce();
    expect(opened[1]?.config.documentId).toBe("document-main");
    expect(opened[1]?.config.collaborationRevision).toBe(1);
    unmount();
  });
});
