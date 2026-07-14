import {
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  CloudUpload,
  Download,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Unlink,
  UserRound
} from "lucide-react";
import {
  ProviderBrandMark,
  type ProviderBrand
} from "@/components/ProviderBrandMark";
import { UiButton, UiHelpTooltip, UiTooltip } from "@/components/ui";
import type {
  ExternalGitCheckpointPhase,
  ExternalGitProjectLinkStatus,
  ExternalGitProjectState
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { ExternalGitInboundProgress } from "@/pages/projects/ExternalGitImportDialog";
import {
  ACTIVE_EXTERNAL_GIT_JOB_STATES,
  EXTERNAL_GIT_SYNC_PHASES,
  externalGitInboundJobActive,
  externalGitPhaseIndex,
  externalGitStatusTone
} from "@/pages/workspace/external-git/model";
import type { ExternalGitInboundSyncController } from "@/pages/workspace/external-git/useExternalGitInboundSync";
import type { ExternalGitProjectActionsController } from "@/pages/workspace/external-git/useExternalGitProjectActions";

export function ExternalGitSyncStateIcon({
  state
}: {
  state: ExternalGitProjectState;
}) {
  if (state === "active") return <CheckCircle2 size={16} aria-hidden />;
  if (ACTIVE_EXTERNAL_GIT_JOB_STATES.has(state)) {
    return <LoaderCircle className="external-git-spin" size={16} aria-hidden />;
  }
  if (["reauth_required", "conflict", "error"].includes(state)) {
    return <AlertTriangle size={16} aria-hidden />;
  }
  if (state === "retry_wait") return <RefreshCw size={16} aria-hidden />;
  return <CloudUpload size={16} aria-hidden />;
}

function SyncPhaseIcon({ phase }: { phase: ExternalGitCheckpointPhase }) {
  if (phase === "snapshot") return <Camera size={12} aria-hidden />;
  if (phase === "commit_local") {
    return <GitCommitHorizontal size={12} aria-hidden />;
  }
  return <CloudUpload size={12} aria-hidden />;
}

function ExternalGitSyncFlow({
  status,
  providerName,
  providerBrand,
  t
}: {
  status: ExternalGitProjectLinkStatus;
  providerName: string;
  providerBrand: ProviderBrand;
  t: Translator;
}) {
  const tone = externalGitStatusTone(status.state);
  return (
    <div
      className={`external-git-sync-flow external-git-sync-flow-${tone}`}
      role="status"
      aria-label={t(`externalGit.state.${status.state}`)}
    >
      <div className="external-git-sync-node">
        <span className="external-git-sync-node-icon">
          <HardDrive size={18} aria-hidden />
        </span>
        <strong>{t("externalGit.workspaceName")}</strong>
        <small>v{status.workspace_version}</small>
      </div>
      <div className="external-git-sync-connector" aria-hidden>
        <span className="external-git-sync-line" />
        <span className="external-git-sync-state-icon">
          <ExternalGitSyncStateIcon state={status.state} />
        </span>
        <ArrowRight className="external-git-sync-arrow" size={14} />
      </div>
      <div className="external-git-sync-node">
        <ProviderBrandMark
          brand={providerBrand}
          size={35}
          className="external-git-sync-node-icon"
        />
        <strong>{providerName}</strong>
        <small>
          {status.synced_workspace_version > 0
            ? `v${status.synced_workspace_version}`
            : "—"}
        </small>
      </div>
    </div>
  );
}

function SyncProgress({
  status,
  t
}: {
  status: ExternalGitProjectLinkStatus;
  t: Translator;
}) {
  if (!["pending", "syncing", "retry_wait"].includes(status.state)) return null;
  const activeIndex = Math.max(0, externalGitPhaseIndex(status.sync_phase));
  return (
    <ol
      className="external-git-sync-progress"
      aria-label={t("externalGit.progressLabel")}
    >
      {EXTERNAL_GIT_SYNC_PHASES.map((phase, index) => {
        const state =
          index < activeIndex
            ? "done"
            : index === activeIndex
              ? "active"
              : "upcoming";
        return (
          <li
            className={`external-git-sync-progress-step is-${state}`}
            key={phase}
          >
            <UiTooltip
              content={t(`externalGit.step.${phase}`)}
              className="external-git-progress-tooltip"
              triggerTabIndex={0}
              triggerAriaLabel={t(`externalGit.step.${phase}`)}
              triggerRole="img"
            >
              <span
                className="external-git-sync-progress-dot"
                aria-current={state === "active" ? "step" : undefined}
              >
                <SyncPhaseIcon phase={phase} />
              </span>
            </UiTooltip>
          </li>
        );
      })}
    </ol>
  );
}

export function ExternalGitLinkedView({
  status,
  providerName,
  providerBrand,
  canManageProject,
  canAuthorize,
  authorize,
  projectActions,
  inboundSync,
  busy,
  t
}: {
  status: ExternalGitProjectLinkStatus;
  providerName: string;
  providerBrand: ProviderBrand;
  canManageProject: boolean;
  canAuthorize: boolean;
  authorize: () => void;
  projectActions: ExternalGitProjectActionsController;
  inboundSync: ExternalGitInboundSyncController;
  busy: boolean;
  t: Translator;
}) {
  const jobActive = ACTIVE_EXTERNAL_GIT_JOB_STATES.has(status.state);
  const pullActive = externalGitInboundJobActive(status);
  const retryable = ["conflict", "error", "retry_wait"].includes(status.state);

  return (
    <>
      {status.web_url ? (
        <a
          className="external-git-repository-link"
          href={status.web_url}
          target="_blank"
          rel="noreferrer"
        >
          <ProviderBrandMark
            brand={providerBrand}
            size={30}
            className="external-git-repository-icon"
          />
          <span className="external-git-repository-copy">
            <strong>{status.full_path}</strong>
          </span>
          <ExternalLink size={15} aria-hidden />
        </a>
      ) : (
        <div className="external-git-repository-link is-static">
          <ProviderBrandMark
            brand={providerBrand}
            size={30}
            className="external-git-repository-icon"
          />
          <strong>{status.full_path}</strong>
        </div>
      )}

      <ExternalGitSyncFlow
        status={status}
        providerName={providerName}
        providerBrand={providerBrand}
        t={t}
      />
      <SyncProgress status={status} t={t} />

      {status.inbound_job &&
        ["pending", "processing", "retry_wait", "paused", "failed"].includes(
          status.inbound_job.state
        ) && (
          <div className="external-git-inbound-status">
            <div className="external-git-inbound-status-heading">
              {pullActive ? (
                <LoaderCircle
                  className="external-git-spin"
                  size={16}
                  aria-hidden
                />
              ) : (
                <Download size={16} aria-hidden />
              )}
              <span>
                <strong>
                  {t("externalGit.inboundFrom", {
                    branch: status.inbound_job.source_branch
                  })}
                </strong>
                <small>
                  {t(`externalGit.inboundState.${status.inbound_job.state}`)}
                </small>
              </span>
            </div>
            <ExternalGitInboundProgress job={status.inbound_job} t={t} />
            {status.inbound_job.last_error && (
              <div className="external-git-inline-alert is-danger">
                {t(`externalGit.error.${status.inbound_job.last_error}`)}
              </div>
            )}
          </div>
        )}

      {status.last_error && (
        <div className="external-git-inline-alert is-danger" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>{t(`externalGit.error.${status.last_error}`)}</span>
        </div>
      )}

      {canManageProject &&
        status.state !== "active" &&
        !jobActive &&
        !pullActive && (
          <div className="external-git-primary-action">
            {status.state === "reauth_required" && canAuthorize ? (
              <UiButton variant="primary" onClick={authorize}>
                <ShieldCheck size={15} aria-hidden />
                {t("externalGit.reauthorize", { provider: providerName })}
              </UiButton>
            ) : status.state === "reauth_required" ? (
              <div className="external-git-inline-alert is-warning">
                <AlertTriangle size={16} aria-hidden />
                <span>
                  {t("externalGit.authorizationUnavailable", {
                    provider: providerName
                  })}
                </span>
              </div>
            ) : (
              <UiButton
                variant="primary"
                onClick={projectActions.checkpoint}
                disabled={busy}
              >
                {projectActions.checkpointPending ? (
                  <LoaderCircle
                    className="external-git-spin"
                    size={15}
                    aria-hidden
                  />
                ) : retryable ? (
                  <RefreshCw size={15} aria-hidden />
                ) : (
                  <CloudUpload size={15} aria-hidden />
                )}
                {projectActions.checkpointPending
                  ? t("externalGit.syncInProgress")
                  : retryable
                    ? t("externalGit.retrySync")
                    : t("externalGit.checkpointNow")}
              </UiButton>
            )}
          </div>
        )}

      {canManageProject && (
        <div className="external-git-primary-action">
          <UiButton
            variant="secondary"
            onClick={inboundSync.openDialog}
            disabled={
              busy ||
              pullActive ||
              status.sync_phase !== null ||
              status.state === "reauth_required"
            }
          >
            {inboundSync.opening ? (
              <LoaderCircle
                className="external-git-spin"
                size={15}
                aria-hidden
              />
            ) : (
              <Download size={15} aria-hidden />
            )}
            {t("externalGit.syncFromBranch")}
          </UiButton>
        </div>
      )}

      <details className="external-git-details">
        <summary>
          <span>
            <Info size={14} aria-hidden />
            {t("externalGit.connectionDetails")}
          </span>
          <ChevronDown size={15} aria-hidden />
        </summary>
        <div className="external-git-details-body">
          <dl className="external-git-detail-list">
            {status.connector_username && (
              <div>
                <dt>
                  <UserRound size={14} aria-hidden />
                  {t("externalGit.authorization")}
                </dt>
                <dd>@{status.connector_username}</dd>
              </div>
            )}
            {status.checkpoint_branch && (
              <div>
                <dt>
                  <GitBranch size={14} aria-hidden />
                  {t("externalGit.branch")}
                </dt>
                <dd>
                  <code>{status.checkpoint_branch}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>
                <ArrowRight size={14} aria-hidden />
                {t("externalGit.direction")}
                <UiHelpTooltip
                  content={t("externalGit.manualSyncHint", {
                    provider: providerName
                  })}
                />
              </dt>
              <dd>
                {t("externalGit.directionValue", { provider: providerName })}
              </dd>
            </div>
          </dl>
          {canManageProject && (
            <div className="external-git-danger-zone">
              <UiButton
                variant="danger"
                size="sm"
                onClick={projectActions.openUnlinkDialog}
                disabled={busy}
              >
                <Unlink size={14} aria-hidden />
                {t("externalGit.unlink")}
              </UiButton>
            </div>
          )}
        </div>
      </details>
    </>
  );
}
