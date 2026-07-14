import type {
  RemoteBranch,
  ExternalGitCheckpointPhase,
  ExternalGitConnectionStatus,
  ExternalGitProjectLinkStatus,
  ExternalGitProjectState
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

export type ExternalGitSetupMode = "none" | "create" | "link";
export type ExternalGitStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger";

export const ACTIVE_EXTERNAL_GIT_JOB_STATES = new Set<ExternalGitProjectState>([
  "pending",
  "syncing"
]);

export const EXTERNAL_GIT_SYNC_PHASES: readonly ExternalGitCheckpointPhase[] = [
  "snapshot",
  "commit_local",
  "push_git"
];

export function projectSlug(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .replace(/[._-]{2,}/g, "-");
  return slug || "typst-project";
}

export function externalGitStatusTone(
  state: ExternalGitProjectState
): ExternalGitStatusTone {
  if (state === "active") return "success";
  if (
    ["linking", "dirty", "pending", "syncing", "retry_wait", "unlinked"].includes(
      state
    )
  ) {
    return "warning";
  }
  if (["reauth_required", "conflict", "error"].includes(state)) {
    return "danger";
  }
  return "neutral";
}

export function shouldPollExternalGitStatus(state: ExternalGitProjectState) {
  return ["pending", "syncing", "retry_wait"].includes(state);
}

export function externalGitInboundJobActive(
  status: ExternalGitProjectLinkStatus
) {
  return (
    !!status.inbound_job &&
    ["pending", "processing", "retry_wait"].includes(status.inbound_job.state)
  );
}

export function externalGitPhaseIndex(
  phase: ExternalGitCheckpointPhase | null
) {
  if (phase === "queued" || !phase) return 0;
  return EXTERNAL_GIT_SYNC_PHASES.findIndex(
    (candidate) => candidate === phase
  );
}

export function externalGitStatusDescription(
  status: ExternalGitProjectLinkStatus,
  providerName: string,
  t: Translator
) {
  switch (status.state) {
    case "active":
      return t("externalGit.summary.active", {
        provider: providerName,
        version: status.workspace_version
      });
    case "dirty":
      return t("externalGit.summary.dirty", {
        provider: providerName,
        saved: status.workspace_version,
        synced: status.synced_workspace_version
      });
    case "pending":
      return t("externalGit.summary.pending");
    case "syncing":
      return status.sync_phase
        ? t(`externalGit.phase.${status.sync_phase}`)
        : t("externalGit.summary.syncing");
    case "retry_wait":
      return status.next_retry_at
        ? t("externalGit.retryAt", {
            time: new Date(status.next_retry_at).toLocaleTimeString()
          })
        : t("externalGit.summary.retry");
    case "reauth_required":
      return t("externalGit.summary.reauthorize", { provider: providerName });
    case "conflict":
      return t("externalGit.summary.conflict", { provider: providerName });
    case "error":
      return t("externalGit.summary.error");
    default:
      return t("externalGit.initialSyncPending");
  }
}

export function unavailableExternalGitStatus(projectId: string): {
  connection: ExternalGitConnectionStatus;
  status: ExternalGitProjectLinkStatus;
} {
  return {
    connection: {
      configured: false,
      bound: false,
      connected: false,
      provider: "",
      provider_name: "",
      base_url: "",
      status: null,
      account_id: null,
      username: null,
      scopes: [],
      expires_at: null,
      can_disconnect: false,
      disconnect_restriction: null
    },
    status: {
      project_id: projectId,
      linked: false,
      provider: null,
      repository_id: null,
      full_path: null,
      web_url: null,
      default_branch: null,
      checkpoint_branch: null,
      connector_username: null,
      workspace_version: 0,
      synced_workspace_version: 0,
      state: "unlinked",
      sync_phase: null,
      next_retry_at: null,
      last_remote_sha: null,
      last_import_branch: null,
      last_import_sha: null,
      last_import_at: null,
      last_import_error: null,
      inbound_job: null,
      last_error: null,
      updated_at: null
    }
  };
}

export function preferredInboundBranch(
  branches: RemoteBranch[],
  status: Pick<
    ExternalGitProjectLinkStatus,
    "last_import_branch" | "default_branch"
  > | null
) {
  return (
    branches.find((branch) => branch.name === status?.last_import_branch) ??
    branches.find((branch) => branch.name === status?.default_branch) ??
    branches.find((branch) => branch.default) ??
    branches[0] ??
    null
  );
}

export function externalGitErrorMessage(
  error: unknown,
  fallback: string
) {
  return error instanceof Error ? error.message : fallback;
}
