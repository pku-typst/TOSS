import { describe, expect, it } from "vitest";
import type { ProcessingJob, ProcessingJobState } from "@/lib/api";
import {
  canCancelProcessingJob,
  countUnseenProcessingFailures,
  isProcessingJobActive,
  latestProcessingFailureCompletedAt,
  processingCapabilitiesQueryKey,
  processingJobsQueryKey,
  processingJobsRefetchInterval,
  projectProcessingCapabilitiesQueryKey,
  readProcessingFailureSeenThrough,
  writeProcessingFailureSeenThrough,
  withProcessingJob
} from "@/pages/processing/model";

function job(
  state: ProcessingJobState,
  cancellationRequested = false
): ProcessingJob {
  const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(state);
  return {
    id: "job-1",
    operation: "latex.compile.pdf/v1",
    project_id: "project-1",
    result_project_id: null,
    state,
    phase: state === "succeeded" ? "complete" : "waiting_for_worker",
    cancellation_requested: cancellationRequested,
    attempt_count: 0,
    processor_contract: null,
    failure: null,
    artifacts: [],
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    completed_at: terminal ? "2026-07-14T00:00:01Z" : null
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("processing task lifecycle", () => {
  it("treats only durable nonterminal states as active", () => {
    for (const state of ["preparing", "queued", "running", "finalizing"] as const) {
      expect(isProcessingJobActive(state)).toBe(true);
    }
    for (const state of ["succeeded", "failed", "cancelled", "expired"] as const) {
      expect(isProcessingJobActive(state)).toBe(false);
    }
  });

  it("stops polling once terminal work is closed", () => {
    expect(processingJobsRefetchInterval([job("running")], false)).toBe(2_000);
    expect(processingJobsRefetchInterval([job("succeeded")], true)).toBe(15_000);
    expect(processingJobsRefetchInterval([job("succeeded")], false)).toBe(false);
  });

  it("does not offer cancellation after finalization or after a request", () => {
    expect(canCancelProcessingJob(job("queued"))).toBe(true);
    expect(canCancelProcessingJob(job("running", true))).toBe(false);
    expect(canCancelProcessingJob(job("finalizing"))).toBe(false);
    expect(canCancelProcessingJob(job("succeeded"))).toBe(false);
  });

  it("isolates cached processing state by signed-in account", () => {
    expect(processingJobsQueryKey("user-a")).not.toEqual(processingJobsQueryKey("user-b"));
    expect(processingCapabilitiesQueryKey("user-a")).not.toEqual(
      processingCapabilitiesQueryKey("user-b")
    );
    expect(projectProcessingCapabilitiesQueryKey("user-a", "project-1")).not.toEqual(
      projectProcessingCapabilitiesQueryKey("user-a", "project-2")
    );
  });

  it("places an updated job first without duplicating it", () => {
    const original = job("queued");
    const updated = { ...original, state: "running" as const };
    const other = { ...original, id: "job-2" };

    expect(withProcessingJob({ jobs: [original, other] }, updated).jobs).toEqual([
      updated,
      other
    ]);
  });

  it("counts only failures completed after the user last viewed tasks", () => {
    const oldFailure = job("failed");
    const newFailure = {
      ...job("expired"),
      id: "job-2",
      completed_at: "2026-07-14T00:00:02Z"
    };
    const success = {
      ...job("succeeded"),
      id: "job-3",
      completed_at: "2026-07-14T00:00:03Z"
    };
    const seenThrough = Date.parse(oldFailure.completed_at!);

    expect(countUnseenProcessingFailures([oldFailure, newFailure, success], seenThrough)).toBe(1);
    expect(latestProcessingFailureCompletedAt([oldFailure, newFailure, success])).toBe(
      Date.parse(newFailure.completed_at)
    );
  });

  it("keeps the failure cursor account-scoped and monotonic", () => {
    const storage = memoryStorage();

    expect(writeProcessingFailureSeenThrough("user-a", 20, storage)).toBe(20);
    expect(writeProcessingFailureSeenThrough("user-a", 10, storage)).toBe(20);
    expect(writeProcessingFailureSeenThrough("user-a", Number.NaN, storage)).toBe(20);
    expect(writeProcessingFailureSeenThrough("user-b", 5, storage)).toBe(5);
    expect(readProcessingFailureSeenThrough("user-a", storage)).toBe(20);
    expect(readProcessingFailureSeenThrough("user-b", storage)).toBe(5);
  });
});
