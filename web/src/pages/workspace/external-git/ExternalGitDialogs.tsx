import { AlertTriangle, Download, LoaderCircle, Unlink } from "lucide-react";
import { UiButton, UiDialog, UiSelect } from "@/components/ui";
import type { Translator } from "@/lib/i18n";
import type { ExternalGitInboundSyncController } from "@/pages/workspace/external-git/useExternalGitInboundSync";
import type { ExternalGitProjectActionsController } from "@/pages/workspace/external-git/useExternalGitProjectActions";

export function ExternalGitDialogs({
  providerName,
  projectActions,
  inboundSync,
  busy,
  t
}: {
  providerName: string;
  projectActions: ExternalGitProjectActionsController;
  inboundSync: ExternalGitInboundSyncController;
  busy: boolean;
  t: Translator;
}) {
  return (
    <>
      <UiDialog
        open={projectActions.unlinkDialogOpen}
        title={t("externalGit.unlinkTitle", { provider: providerName })}
        description={t("externalGit.unlinkConfirm", {
          provider: providerName
        })}
        onClose={projectActions.closeUnlinkDialog}
        actions={
          <>
            <UiButton
              onClick={projectActions.closeUnlinkDialog}
              disabled={busy}
            >
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="danger"
              onClick={projectActions.unlink}
              disabled={busy}
            >
              <Unlink size={14} aria-hidden />
              {projectActions.busy
                ? t("common.loading")
                : t("externalGit.unlink")}
            </UiButton>
          </>
        }
      />
      <UiDialog
        open={inboundSync.dialogOpen}
        title={t("externalGit.syncFromBranchTitle", { provider: providerName })}
        description={t("externalGit.syncFromBranchWarning")}
        onClose={inboundSync.closeDialog}
        actions={
          <>
            <UiButton onClick={inboundSync.closeDialog} disabled={busy}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="danger"
              onClick={inboundSync.submit}
              disabled={busy || !inboundSync.canSubmit}
            >
              {inboundSync.syncing ? (
                <LoaderCircle
                  className="external-git-spin"
                  size={14}
                  aria-hidden
                />
              ) : (
                <Download size={14} aria-hidden />
              )}
              {inboundSync.syncing
                ? t("common.loading")
                : t("externalGit.replaceFromBranch")}
            </UiButton>
          </>
        }
      >
        <div className="external-git-inbound-dialog">
          <UiSelect
            label={t("externalGit.sourceBranch")}
            value={inboundSync.branch}
            onChange={(event) => inboundSync.setBranch(event.target.value)}
            disabled={busy}
          >
            {inboundSync.branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </UiSelect>
          <div className="external-git-inline-alert is-warning">
            <AlertTriangle size={16} aria-hidden />
            <span>{t("externalGit.syncRecoveryHint")}</span>
          </div>
        </div>
      </UiDialog>
    </>
  );
}
