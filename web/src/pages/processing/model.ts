import type { ProcessingJob, ProcessingJobState } from "@/lib/api";

export const PROCESSING_TASK_CENTER_OPEN_EVENT = "toss:processing-task-center-open";

export function processingJobsQueryKey(userId: string) {
  return ["processing", "jobs", userId] as const;
}

export function processingCapabilitiesQueryKey(userId: string) {
  return ["processing", "capabilities", userId] as const;
}

export function isProcessingJobActive(state: ProcessingJobState) {
  return ["preparing", "queued", "running", "finalizing"].includes(state);
}

export function canCancelProcessingJob(job: ProcessingJob) {
  return (
    !job.cancellation_requested &&
    ["preparing", "queued", "running"].includes(job.state)
  );
}

export function processingJobsRefetchInterval(
  jobs: ProcessingJob[],
  taskCenterOpen: boolean
): number | false {
  if (jobs.some((job) => isProcessingJobActive(job.state))) return 2_000;
  return taskCenterOpen ? 15_000 : false;
}

export function openProcessingTaskCenter() {
  window.dispatchEvent(new Event(PROCESSING_TASK_CENTER_OPEN_EVENT));
}
