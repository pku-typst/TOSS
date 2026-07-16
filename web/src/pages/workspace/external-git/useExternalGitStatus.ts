import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getExternalGitConnectionStatus,
  getExternalGitProjectStatus
} from "@/lib/api";
import {
  externalGitInboundJobActive,
  shouldPollExternalGitStatus,
  unavailableExternalGitStatus
} from "@/pages/workspace/external-git/model";

function activeStatusPollInterval(updatedAt: string | null): number {
  const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(parsedUpdatedAt)) return 5000;
  const unchangedForMs = Math.max(0, Date.now() - parsedUpdatedAt);
  if (unchangedForMs < 30_000) return 3000;
  if (unchangedForMs < 120_000) return 5000;
  return 10_000;
}

export function useExternalGitStatus(
  projectId: string,
  configured: boolean,
  selectedProviderId: string
) {
  const unavailableStatus = useMemo(
    () => unavailableExternalGitStatus(projectId),
    [projectId]
  );
  const statusQuery = useQuery({
    queryKey: ["external-git-status", projectId, selectedProviderId],
    queryFn: async () => {
      const status = await getExternalGitProjectStatus(projectId);
      const providerId = status.provider ?? selectedProviderId;
      const connection = await getExternalGitConnectionStatus(providerId);
      return { connection, status };
    },
    enabled: !!projectId && configured && !!selectedProviderId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (
        !status?.linked ||
        (!shouldPollExternalGitStatus(status.state) &&
          !externalGitInboundJobActive(status))
      ) {
        return false;
      }
      return activeStatusPollInterval(
        status.inbound_job?.updated_at ?? status.updated_at
      );
    }
  });
  const refetchStatus = statusQuery.refetch;
  const snapshot = configured ? statusQuery.data ?? null : unavailableStatus;
  const refresh = useCallback(async () => {
    if (!configured) return;
    const result = await refetchStatus();
    if (result.error) throw result.error;
  }, [configured, refetchStatus]);

  return {
    connection: snapshot?.connection ?? null,
    status: snapshot?.status ?? null,
    error: statusQuery.data ? null : statusQuery.error,
    refresh
  };
}
