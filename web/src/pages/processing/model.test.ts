import { describe, expect, it } from "vitest";
import type { ProcessingJob, ProcessingJobState } from "@/lib/api";
import {
  canCancelProcessingJob,
  isProcessingJobActive,
  processingCapabilitiesQueryKey,
  processingJobsQueryKey,
  processingJobsRefetchInterval,
  projectProcessingCapabilitiesQueryKey,
  withProcessingJob
} from "@/pages/processing/model";

function job(
  state: ProcessingJobState,
  cancellationRequested = false
): ProcessingJob {
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
    completed_at: state === "succeeded" ? "2026-07-14T00:00:01Z" : null
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
});
