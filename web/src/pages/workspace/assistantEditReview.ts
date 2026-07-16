import type {
  AiPatchCompileVerification,
  AiWorkspaceEditReviewDecision,
  AiWorkspaceEditReviewOutcome
} from "@/features/ai/toolContract";

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

export type AssistantEditReviewDecision = AiWorkspaceEditReviewDecision;

export type AssistantEditReviewRequestResult =
  | { outcome: "pending"; reviewId: string }
  | { outcome: "cancelled" | "busy"; reviewId: null };

export type AssistantEditReviewOutcome = AiWorkspaceEditReviewOutcome;

type ProposalInput = Omit<AssistantEditProposal, "id">;

type PendingReview = { proposal: AssistantEditProposal };

const MAX_REVIEW_OUTCOMES = 32;

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
  private snapshot: {
    proposal: AssistantEditProposal | null;
    outcomes: readonly AssistantEditReviewOutcome[];
  } = { proposal: null, outcomes: [] };
  private pending: PendingReview | null = null;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(readonly scopeId: string = "") {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  request(input: ProposalInput, signal?: AbortSignal): AssistantEditReviewRequestResult {
    if (this.disposed || signal?.aborted) return { outcome: "cancelled", reviewId: null };
    if (this.pending) return { outcome: "busy", reviewId: null };
    const proposal = { ...input, id: proposalId() };
    this.pending = { proposal };
    this.snapshot = { ...this.snapshot, proposal };
    this.emit();
    return { outcome: "pending", reviewId: proposal.id };
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

  private finish(id: string, decision: AssistantEditReviewDecision) {
    const pending = this.pending;
    if (!pending || pending.proposal.id !== id) return false;
    this.pending = null;
    const outcome = { reviewId: id, decision, decidedAt: Date.now() };
    this.snapshot = {
      proposal: null,
      outcomes: [...this.snapshot.outcomes, outcome].slice(-MAX_REVIEW_OUTCOMES)
    };
    this.emit();
    return true;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
