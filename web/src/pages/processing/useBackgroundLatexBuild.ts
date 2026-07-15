import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLatexPdfBuild,
  getProcessingCapabilities,
  type ProcessingCapabilityState,
  type ProcessingJobList
} from "@/lib/api";
import {
  openProcessingTaskCenter,
  processingCapabilitiesQueryKey,
  processingJobsQueryKey
} from "@/pages/processing/model";

export function useBackgroundLatexBuild({
  projectId,
  userId,
  enabled
}: {
  projectId: string;
  userId: string | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const capabilityQuery = useQuery({
    queryKey: processingCapabilitiesQueryKey(userId ?? "anonymous"),
    queryFn: getProcessingCapabilities,
    enabled: enabled && !!userId,
    staleTime: 10_000,
    refetchInterval: enabled && userId ? 15_000 : false
  });
  const capability = capabilityQuery.data?.capabilities.find(
    (candidate) => candidate.operation === "latex.compile.pdf/v1"
  );
  const mutation = useMutation({
    mutationFn: () => createLatexPdfBuild(projectId),
    onSuccess: (job) => {
      if (!userId) return;
      queryClient.setQueryData<ProcessingJobList>(
        processingJobsQueryKey(userId),
        (current) => ({
          jobs: [job, ...(current?.jobs ?? []).filter((candidate) => candidate.id !== job.id)]
        })
      );
      void queryClient.invalidateQueries({
        queryKey: processingCapabilitiesQueryKey(userId)
      });
      openProcessingTaskCenter();
    }
  });

  return {
    visible: enabled && !!userId,
    state: (capability?.state ??
      (capabilityQuery.isPending ? "loading" : "unavailable")) as
      | ProcessingCapabilityState
      | "loading",
    reason: capability?.reason ?? null,
    submit: mutation.mutate,
    pending: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null
  };
}
