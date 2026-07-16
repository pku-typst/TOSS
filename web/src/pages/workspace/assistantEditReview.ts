import type { AiPatchCompileVerification } from "@/features/ai/toolContract";

export type AssistantEditProposal = {
  id: string;
  editKind: "patch" | "full-file";
  path: string;
  baseSnapshot: string;
  baseText: string;
  candidateText: string;
  patch: string;
  addedLines: number;
  removedLines: number;
  hunkCount: number;
  verification: AiPatchCompileVerification;
  verificationRevision: object;
};

export type AssistantEditReviewDecision =
  | "accepted"
  | "rejected"
  | "stale"
  | "cancelled"
  | "busy";

type ProposalInput = Omit<AssistantEditProposal, "id">;

type PendingReview = {
  proposal: AssistantEditProposal;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (decision: AssistantEditReviewDecision) => void;
};

function proposalId() {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return `review-${globalThis.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `review-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Workspace-owned single-proposal coordinator. */
export class AssistantEditReviewCoordinator {
  private snapshot: { proposal: AssistantEditProposal | null } = { proposal: null };
  private pending: PendingReview | null = null;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(readonly scopeId: string = "") {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  request(input: ProposalInput, signal?: AbortSignal): Promise<AssistantEditReviewDecision> {
    if (this.disposed || signal?.aborted) return Promise.resolve("cancelled");
    if (this.pending) return Promise.resolve("busy");
    const proposal = { ...input, id: proposalId() };
    return new Promise((resolve) => {
      const onAbort = signal
        ? () => this.finish(proposal.id, "cancelled")
        : undefined;
      this.pending = { proposal, signal, onAbort, resolve };
      signal?.addEventListener("abort", onAbort!, { once: true });
      this.snapshot = { proposal };
      this.emit();
    });
  }

  accept(id: string) {
    return this.finish(id, "accepted");
  }

  reject(id: string) {
    return this.finish(id, "rejected");
  }

  markStale(id: string) {
    return this.finish(id, "stale");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending) this.finish(this.pending.proposal.id, "cancelled");
    this.listeners.clear();
  }

  private finish(id: string, decision: Exclude<AssistantEditReviewDecision, "busy">) {
    const pending = this.pending;
    if (!pending || pending.proposal.id !== id) return false;
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending = null;
    this.snapshot = { proposal: null };
    this.emit();
    pending.resolve(decision);
    return true;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
