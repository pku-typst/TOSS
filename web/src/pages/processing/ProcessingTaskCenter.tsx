import { useEffect, useMemo, useRef, useState } from "react";
import "@/pages/processing/styles.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Download, FolderOpen, ListTodo, LoaderCircle, X } from "lucide-react";
import { UiBadge, UiButton, UiEmptyState, UiIconButton } from "@/components/ui";
import {
  cancelProcessingJob,
  downloadProcessingArtifact,
  listProcessingJobs,
  type ProcessingArtifact,
  type ProcessingJob,
  type ProcessingJobList,
  type Project
} from "@/lib/api";
import type { Translator, UiLocale } from "@/lib/i18n";
import {
  canCancelProcessingJob,
  countUnseenProcessingFailures,
  isProcessingJobActive,
  latestProcessingFailureCompletedAt,
  PROCESSING_TASK_CENTER_OPEN_EVENT,
  processingJobsQueryKey,
  processingJobsRefetchInterval,
  readProcessingFailureSeenThrough,
  writeProcessingFailureSeenThrough
} from "@/pages/processing/model";

const EMPTY_PROCESSING_JOBS: ProcessingJob[] = [];

function stateTone(job: ProcessingJob): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (job.state === "succeeded") return "success";
  if (job.state === "failed" || job.state === "expired") return "danger";
  if (job.state === "cancelled") return "neutral";
  if (job.state === "queued" || job.cancellation_requested) return "warning";
  return "accent";
}

function operationLabel(job: ProcessingJob, t: Translator) {
  switch (job.operation) {
    case "latex.compile.pdf/v1":
      return t("processing.operation.latexPdf");
    case "typst.export.pptx/v1":
      return t("processing.operation.typstPptx");
    case "pptx.import.typst/v1":
      return t("processing.operation.pptxTypst");
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ProcessingTaskCenter({
  userId,
  projects,
  onOpenProject,
  locale,
  t
}: {
  userId: string;
  projects: Project[];
  onOpenProject: (projectId: string) => Promise<void>;
  locale: UiLocale;
  t: Translator;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<string | null>(null);
  const [openProjectError, setOpenProjectError] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [failureSeen, setFailureSeen] = useState(() => ({
    userId,
    seenThrough: readProcessingFailureSeenThrough(userId)
  }));
  const dialogRef = useRef<HTMLElement | null>(null);
  const queryKey = processingJobsQueryKey(userId);
  const jobsQuery = useQuery({
    queryKey,
    queryFn: listProcessingJobs,
    refetchInterval: (query) =>
      processingJobsRefetchInterval(query.state.data?.jobs ?? [], open)
  });
  const cancelMutation = useMutation({
    mutationFn: cancelProcessingJob,
    onSuccess: (updated) => {
      queryClient.setQueryData<ProcessingJobList>(queryKey, (current) => ({
        jobs: (current?.jobs ?? []).map((job) => (job.id === updated.id ? updated : job))
      }));
    }
  });

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(PROCESSING_TASK_CENTER_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(PROCESSING_TASK_CENTER_OPEN_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    setOpen(false);
    setDownloadError(null);
    setDownloadingArtifactId(null);
    setOpenProjectError(null);
    setOpeningProjectId(null);
    setFailureSeen({
      userId,
      seenThrough: readProcessingFailureSeenThrough(userId)
    });
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, nve-button, nve-icon-button, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  const jobs = jobsQuery.data?.jobs ?? EMPTY_PROCESSING_JOBS;
  const activeCount = jobs.filter((job) => isProcessingJobActive(job.state)).length;
  const failureSeenThrough =
    failureSeen.userId === userId
      ? failureSeen.seenThrough
      : readProcessingFailureSeenThrough(userId);
  const unseenFailureCount = countUnseenProcessingFailures(jobs, failureSeenThrough);

  useEffect(() => {
    if (!open || failureSeen.userId !== userId) return;
    const latestFailure = latestProcessingFailureCompletedAt(jobs);
    if (latestFailure <= failureSeen.seenThrough) return;
    setFailureSeen({
      userId,
      seenThrough: writeProcessingFailureSeenThrough(userId, latestFailure)
    });
  }, [failureSeen.seenThrough, failureSeen.userId, jobs, open, userId]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );
  const badgeLabel = t("processing.triggerLabel", {
    active: activeCount,
    failed: unseenFailureCount
  });

  async function downloadArtifact(artifact: ProcessingArtifact) {
    setDownloadingArtifactId(artifact.id);
    setDownloadError(null);
    try {
      saveBlob(await downloadProcessingArtifact(artifact.download_url), artifact.filename);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : t("processing.downloadFailed"));
    } finally {
      setDownloadingArtifactId(null);
    }
  }

  async function openResultProject(projectId: string) {
    setOpeningProjectId(projectId);
    setOpenProjectError(null);
    try {
      await onOpenProject(projectId);
      setOpen(false);
    } catch (error) {
      setOpenProjectError(
        error instanceof Error ? error.message : t("processing.openProjectFailed")
      );
    } finally {
      setOpeningProjectId(null);
    }
  }

  return (
    <>
      <span className="processing-task-trigger">
        <UiIconButton
          tooltip={t("processing.title")}
          label={badgeLabel}
          className={open ? "active" : ""}
          onClick={() => setOpen(true)}
        >
          <ListTodo size={17} aria-hidden />
        </UiIconButton>
        {(activeCount > 0 || unseenFailureCount > 0) && (
          <span
            className={`processing-task-count${unseenFailureCount > 0 ? " has-failure" : ""}`}
            aria-hidden
          >
            {activeCount > 99 ? "99+" : activeCount || "!"}
          </span>
        )}
      </span>
      {open && (
        <div
          className="processing-task-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <aside
            ref={dialogRef}
            className="processing-task-center"
            role="dialog"
            aria-modal="true"
            aria-label={t("processing.title")}
            tabIndex={-1}
          >
            <header className="processing-task-header">
              <div>
                <h2>{t("processing.title")}</h2>
                <p>{t("processing.subtitle")}</p>
              </div>
              <UiIconButton
                tooltip={t("common.close")}
                label={t("common.close")}
                onClick={() => setOpen(false)}
              >
                <X size={18} aria-hidden />
              </UiIconButton>
            </header>
            <div className="processing-task-body" aria-live="polite">
              {jobsQuery.isPending ? (
                <div className="processing-task-loading">
                  <LoaderCircle className="spin" size={22} aria-hidden />
                  <span>{t("common.loading")}</span>
                </div>
              ) : jobsQuery.error ? (
                <nve-alert status="danger">
                  <strong>{t("processing.loadFailed")}</strong>
                  <span>{jobsQuery.error.message}</span>
                  <UiButton slot="actions" size="sm" onClick={() => void jobsQuery.refetch()}>
                    {t("common.retry")}
                  </UiButton>
                </nve-alert>
              ) : jobs.length === 0 ? (
                <UiEmptyState
                  className="processing-task-empty"
                  icon={<ListTodo size={28} />}
                  iconFrame
                  title={t("processing.empty")}
                  description={t("processing.emptyHint")}
                />
              ) : (
                <div className="processing-task-list">
                  {jobs.map((job) => (
                    <article className="processing-task-item" key={job.id}>
                      <div className="processing-task-item-heading">
                        <div>
                          <strong>{operationLabel(job, t)}</strong>
                          {job.project_id && (
                            <span>{projectNames.get(job.project_id) ?? t("processing.project")}</span>
                          )}
                        </div>
                        <UiBadge tone={stateTone(job)}>
                          {job.cancellation_requested
                            ? t("processing.cancelling")
                            : t(`processing.state.${job.state}`)}
                        </UiBadge>
                      </div>
                      {isProcessingJobActive(job.state) && (
                        <div className="processing-task-progress">
                          <LoaderCircle className="spin" size={14} aria-hidden />
                          <span>{t(`processing.phase.${job.phase}`)}</span>
                        </div>
                      )}
                      {job.failure && (
                        <nve-alert status="danger" className="processing-task-failure">
                          <strong>{job.failure.code}</strong>
                          <span>{job.failure.message}</span>
                        </nve-alert>
                      )}
                      {job.artifacts.length > 0 && (
                        <div className="processing-task-artifacts">
                          {job.artifacts.map((artifact) => (
                            <UiButton
                              key={artifact.id}
                              size="sm"
                              onClick={() => void downloadArtifact(artifact)}
                              disabled={downloadingArtifactId === artifact.id}
                            >
                              {downloadingArtifactId === artifact.id ? (
                                <LoaderCircle className="spin" size={14} aria-hidden />
                              ) : (
                                <Download size={14} aria-hidden />
                              )}
                              {artifact.filename}
                            </UiButton>
                          ))}
                        </div>
                      )}
                      <footer className="processing-task-footer">
                        <time dateTime={job.updated_at}>
                          {dateFormatter.format(new Date(job.updated_at))}
                        </time>
                        <div className="processing-task-actions">
                          {job.state === "succeeded" && job.result_project_id && (
                            <UiButton
                              size="sm"
                              variant="primary"
                              disabled={openingProjectId === job.result_project_id}
                              onClick={() => void openResultProject(job.result_project_id!)}
                            >
                              {openingProjectId === job.result_project_id ? (
                                <LoaderCircle className="spin" size={14} aria-hidden />
                              ) : (
                                <FolderOpen size={14} aria-hidden />
                              )}
                              {t("processing.openProject")}
                            </UiButton>
                          )}
                          {canCancelProcessingJob(job) && (
                            <UiButton
                              size="sm"
                              variant="ghost"
                              disabled={cancelMutation.isPending}
                              onClick={() => {
                                cancelMutation.reset();
                                cancelMutation.mutate(job.id);
                              }}
                            >
                              <Ban size={14} aria-hidden />
                              {t("common.cancel")}
                            </UiButton>
                          )}
                        </div>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
              {(downloadError || openProjectError || cancelMutation.error) && (
                <nve-alert status="danger">
                  <span>
                    {downloadError ??
                      openProjectError ??
                      (cancelMutation.error instanceof Error
                        ? cancelMutation.error.message
                        : t("processing.cancelFailed"))}
                  </span>
                </nve-alert>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
