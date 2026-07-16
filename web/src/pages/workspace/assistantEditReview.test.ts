import { describe, expect, it, vi } from "vitest";
import { AssistantEditReviewCoordinator } from "@/pages/workspace/assistantEditReview";

const verificationRevision = {};

function proposal() {
  return {
    editKind: "patch" as const,
    path: "main.typ",
    baseSnapshot: "sha256-base",
    baseText: "= Old\n",
    candidateText: "= New\n",
    patch: "--- a/main.typ\n+++ b/main.typ\n@@ -1 +1 @@\n-= Old\n+= New",
    addedLines: 1,
    removedLines: 1,
    hunkCount: 1,
    verification: {
      status: "passed" as const,
      errors: [],
      diagnostics: [],
      truncated: false
    },
    verificationRevision
  };
}

describe("AssistantEditReviewCoordinator", () => {
  it("hands one proposal to Workspace ownership without waiting for a decision", () => {
    const coordinator = new AssistantEditReviewCoordinator();
    const listener = vi.fn();
    coordinator.subscribe(listener);
    const pending = coordinator.request(proposal());
    const current = coordinator.getSnapshot().proposal;
    expect(pending).toEqual({ outcome: "pending", reviewId: current!.id });
    expect(current).toMatchObject({ path: "main.typ", candidateText: "= New\n" });
    expect(coordinator.request(proposal())).toEqual({ outcome: "busy", reviewId: null });
    expect(coordinator.accept("another-review")).toBe(false);
    expect(coordinator.accept(current!.id)).toBe(true);
    expect(coordinator.getSnapshot().proposal).toBeNull();
    expect(coordinator.getSnapshot().outcomes).toEqual([
      expect.objectContaining({ reviewId: current!.id, decision: "accepted" })
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not let a completed tool-call signal cancel Workspace-owned review", () => {
    const coordinator = new AssistantEditReviewCoordinator();
    const controller = new AbortController();
    const pending = coordinator.request(proposal(), controller.signal);
    const id = coordinator.getSnapshot().proposal!.id;
    controller.abort();
    expect(pending).toEqual({ outcome: "pending", reviewId: id });
    expect(coordinator.getSnapshot().proposal?.id).toBe(id);
    expect(coordinator.reject(id)).toBe(true);
  });

  it("reports a collaboration-stale proposal and ignores a late accept", () => {
    const coordinator = new AssistantEditReviewCoordinator("generation-1:live");
    coordinator.request(proposal());
    const id = coordinator.getSnapshot().proposal!.id;
    expect(coordinator.markStale(id)).toBe(true);
    expect(coordinator.getSnapshot().outcomes.at(-1)).toMatchObject({
      reviewId: id,
      decision: "stale"
    });
    expect(coordinator.accept(id)).toBe(false);
  });

  it("rejects an already-aborted request before it transfers ownership", () => {
    const coordinator = new AssistantEditReviewCoordinator();
    const controller = new AbortController();
    controller.abort();
    expect(coordinator.request(proposal(), controller.signal)).toEqual({
      outcome: "cancelled",
      reviewId: null
    });
    expect(coordinator.getSnapshot().proposal).toBeNull();
  });
});
