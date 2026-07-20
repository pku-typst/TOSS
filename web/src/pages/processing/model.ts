import type {
  ProcessingJob,
  ProcessingJobList,
  ProcessingJobState
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

export const PROCESSING_TASK_CENTER_OPEN_EVENT = "toss:processing-task-center-open";

export function processingJobsQueryKey(userId: string) {
  return ["processing", "jobs", userId] as const;
}

export function processingCapabilitiesQueryKey(userId: string) {
  return ["processing", "capabilities", userId] as const;
}

export function projectProcessingCapabilitiesQueryKey(
  userId: string,
  projectId: string
) {
  return ["processing", "project-capabilities", userId, projectId] as const;
}

export function withProcessingJob(
  current: ProcessingJobList | undefined,
  job: ProcessingJob
): ProcessingJobList {
  return {
    jobs: [
      job,
      ...(current?.jobs ?? []).filter((candidate) => candidate.id !== job.id)
    ]
  };
}

export function processingCapabilityReasonLabel(
  reason: string | null,
  t: Translator
) {
  switch (reason) {
    case "worker_temporarily_offline":
      return t("processing.reason.workerOffline");
    case "dynamic_typst_dependency":
      return t("processing.reason.dynamicDependency");
    default:
      return t("processing.reason.unavailable");
  }
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
