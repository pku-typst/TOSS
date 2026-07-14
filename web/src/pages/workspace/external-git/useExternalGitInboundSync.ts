import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  listLinkedExternalGitRepositoryBranches,
  requestExternalGitInboundSync,
  type ExternalGitProjectLinkStatus
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import {
  externalGitErrorMessage,
  preferredInboundBranch
} from "@/pages/workspace/external-git/model";

export function useExternalGitInboundSync({
  projectId,
  status,
  refreshStatus,
  t
}: {
  projectId: string;
  status: ExternalGitProjectLinkStatus | null;
  refreshStatus: () => Promise<void>;
  t: Translator;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const branchesQuery = useQuery({
    queryKey: ["external-git-linked-branches", projectId],
    queryFn: () => listLinkedExternalGitRepositoryBranches(projectId),
    enabled: false,
    staleTime: 30_000
  });
  const syncMutation = useMutation({
    mutationFn: () => requestExternalGitInboundSync(projectId, branch),
    onSuccess: async () => {
      setDialogOpen(false);
      await refreshStatus();
    }
  });

  async function openDialog() {
    syncMutation.reset();
    const result = await branchesQuery.refetch();
    if (result.error || !result.data) return;
    setBranch(preferredInboundBranch(result.data.branches, status)?.name ?? "");
    setDialogOpen(true);
  }

  const error = branchesQuery.error
    ? externalGitErrorMessage(branchesQuery.error, t("externalGit.loadFailed"))
    : syncMutation.error
      ? externalGitErrorMessage(
          syncMutation.error,
          t("externalGit.inboundSyncFailed")
        )
      : null;

  return {
    error,
    busy: branchesQuery.isFetching || syncMutation.isPending,
    opening: branchesQuery.isFetching,
    syncing: syncMutation.isPending,
    dialogOpen,
    openDialog,
    closeDialog: () => setDialogOpen(false),
    branches: branchesQuery.data?.branches ?? [],
    branch,
    setBranch,
    canSubmit: !!branch,
    submit: () => {
      if (branch) syncMutation.mutate();
    }
  };
}

export type ExternalGitInboundSyncController = ReturnType<
  typeof useExternalGitInboundSync
>;
