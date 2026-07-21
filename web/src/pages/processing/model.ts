import type {
  ProcessingJob,
  ProcessingJobList,
  ProcessingJobState
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

export const PROCESSING_TASK_CENTER_OPEN_EVENT = "toss:processing-task-center-open";

const PROCESSING_FAILURE_SEEN_STORAGE_PREFIX = "toss.processing.failure-seen-through.";

type ProcessingFailureSeenStorage = Pick<Storage, "getItem" | "setItem">;

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
    default:
      return t("processing.reason.unavailable");
  }
}

export function isProcessingJobActive(state: ProcessingJobState) {
  return ["preparing", "queued", "running", "finalizing"].includes(state);
}

function processingFailureCompletedAt(job: ProcessingJob) {
  if (job.state !== "failed" && job.state !== "expired") return null;
  const completedAt = Date.parse(job.completed_at ?? "");
  return Number.isFinite(completedAt) ? completedAt : null;
}

export function latestProcessingFailureCompletedAt(jobs: ProcessingJob[]) {
  return jobs.reduce((latest, job) => {
    const completedAt = processingFailureCompletedAt(job);
    return completedAt === null ? latest : Math.max(latest, completedAt);
  }, 0);
}

export function countUnseenProcessingFailures(
  jobs: ProcessingJob[],
  seenThrough: number
) {
  return jobs.filter((job) => {
    const completedAt = processingFailureCompletedAt(job);
    return completedAt !== null && completedAt > seenThrough;
  }).length;
}

function processingFailureSeenStorageKey(userId: string) {
  return `${PROCESSING_FAILURE_SEEN_STORAGE_PREFIX}${userId}`;
}

export function readProcessingFailureSeenThrough(
  userId: string,
  storage?: ProcessingFailureSeenStorage
) {
  try {
    const raw = (storage ?? window.localStorage).getItem(
      processingFailureSeenStorageKey(userId)
    );
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeProcessingFailureSeenThrough(
  userId: string,
  seenThrough: number,
  storage?: ProcessingFailureSeenStorage
) {
  const value = Number.isFinite(seenThrough) && seenThrough >= 0 ? seenThrough : 0;
  try {
    const target = storage ?? window.localStorage;
    const persisted = Math.max(
      readProcessingFailureSeenThrough(userId, target),
      value
    );
    target.setItem(processingFailureSeenStorageKey(userId), String(persisted));
    return persisted;
  } catch {
    return value;
  }
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
