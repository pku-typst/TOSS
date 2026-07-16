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
  it("allows one review and resolves only the matching proposal", async () => {
    const coordinator = new AssistantEditReviewCoordinator();
    const listener = vi.fn();
    coordinator.subscribe(listener);
    const pending = coordinator.request(proposal());
    const current = coordinator.getSnapshot().proposal;
    expect(current).toMatchObject({ path: "main.typ", candidateText: "= New\n" });
    await expect(coordinator.request(proposal())).resolves.toBe("busy");
    expect(coordinator.accept("another-review")).toBe(false);
    expect(coordinator.accept(current!.id)).toBe(true);
    await expect(pending).resolves.toBe("accepted");
    expect(coordinator.getSnapshot().proposal).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("crosses cancellation into the pending human review", async () => {
    const coordinator = new AssistantEditReviewCoordinator();
    const controller = new AbortController();
    const pending = coordinator.request(proposal(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe("cancelled");
    expect(coordinator.getSnapshot().proposal).toBeNull();
  });

  it("reports a collaboration-stale proposal and ignores a late accept", async () => {
    const coordinator = new AssistantEditReviewCoordinator("generation-1:live");
    const pending = coordinator.request(proposal());
    const id = coordinator.getSnapshot().proposal!.id;
    expect(coordinator.markStale(id)).toBe(true);
    await expect(pending).resolves.toBe("stale");
    expect(coordinator.accept(id)).toBe(false);
  });
});
