import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTypstPptxExport,
  getProjectProcessingCapabilities,
  type ProcessingJobList,
  type ProjectProcessingCapabilityState
} from "@/lib/api";
import {
  openProcessingTaskCenter,
  processingJobsQueryKey,
  projectProcessingCapabilitiesQueryKey,
  withProcessingJob
} from "@/pages/processing/model";

export function usePptxExport({
  projectId,
  userId,
  enabled
}: {
  projectId: string;
  userId: string | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = projectProcessingCapabilitiesQueryKey(
    userId ?? "anonymous",
    projectId
  );
  const capabilityQuery = useQuery({
    queryKey,
    queryFn: () => getProjectProcessingCapabilities(projectId),
    enabled: enabled && !!userId,
    staleTime: 10_000,
    refetchInterval: enabled && userId ? 15_000 : false
  });
  const capability = capabilityQuery.data?.capabilities.find(
    (candidate) => candidate.operation === "typst.export.pptx/v1"
  );
  const mutation = useMutation({
    mutationFn: () => createTypstPptxExport(projectId),
    onSuccess: (job) => {
      if (!userId) return;
      queryClient.setQueryData<ProcessingJobList>(
        processingJobsQueryKey(userId),
        (current) => withProcessingJob(current, job)
      );
      void queryClient.invalidateQueries({ queryKey });
      openProcessingTaskCenter();
    }
  });
  const inScope = enabled && !!userId;

  return {
    visible: inScope && capability !== undefined,
    state: (capability?.state ??
      (capabilityQuery.isPending ? "loading" : "error")) as
      | ProjectProcessingCapabilityState
      | "loading"
      | "error",
    reason: capability?.reason ?? null,
    submit: mutation.mutateAsync,
    pending: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
    reset: mutation.reset
  };
}
