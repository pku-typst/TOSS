import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  requestExternalGitCheckpoint,
  unlinkExternalGitRepository
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { externalGitErrorMessage } from "@/pages/workspace/external-git/model";

export function useExternalGitProjectActions({
  projectId,
  refreshStatus,
  t
}: {
  projectId: string;
  refreshStatus: () => Promise<void>;
  t: Translator;
}) {
  const [unlinkDialogOpen, setUnlinkDialogOpen] = useState(false);
  const checkpointMutation = useMutation({
    mutationFn: () => requestExternalGitCheckpoint(projectId),
    onSuccess: refreshStatus
  });
  const unlinkMutation = useMutation({
    mutationFn: () => unlinkExternalGitRepository(projectId),
    onSuccess: async () => {
      setUnlinkDialogOpen(false);
      await refreshStatus();
    }
  });
  const error = checkpointMutation.error
    ? externalGitErrorMessage(
        checkpointMutation.error,
        t("externalGit.checkpointFailed")
      )
    : unlinkMutation.error
      ? externalGitErrorMessage(
          unlinkMutation.error,
          t("externalGit.unlinkFailed")
        )
      : null;

  return {
    error,
    busy: checkpointMutation.isPending || unlinkMutation.isPending,
    checkpointPending: checkpointMutation.isPending,
    checkpoint: () => {
      unlinkMutation.reset();
      checkpointMutation.mutate();
    },
    unlinkDialogOpen,
    openUnlinkDialog: () => {
      checkpointMutation.reset();
      unlinkMutation.reset();
      setUnlinkDialogOpen(true);
    },
    closeUnlinkDialog: () => setUnlinkDialogOpen(false),
    unlink: () => unlinkMutation.mutate()
  };
}

export type ExternalGitProjectActionsController = ReturnType<
  typeof useExternalGitProjectActions
>;
