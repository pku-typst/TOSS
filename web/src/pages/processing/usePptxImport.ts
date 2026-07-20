import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPptxImport,
  getProcessingCapabilities,
  type ProcessingCapabilityState,
  type ProcessingJobList,
  type PptxConversionMode
} from "@/lib/api";
import {
  openProcessingTaskCenter,
  processingCapabilitiesQueryKey,
  processingJobsQueryKey,
  withProcessingJob
} from "@/pages/processing/model";

export function usePptxImport({
  userId,
  enabled
}: {
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
    (candidate) => candidate.operation === "pptx.import.typst/v1"
  );
  const mutation = useMutation({
    mutationFn: ({ file, mode }: { file: File; mode: PptxConversionMode }) =>
      createPptxImport(file, mode),
    onSuccess: (job) => {
      if (!userId) return;
      queryClient.setQueryData<ProcessingJobList>(
        processingJobsQueryKey(userId),
        (current) => withProcessingJob(current, job)
      );
      void queryClient.invalidateQueries({
        queryKey: processingCapabilitiesQueryKey(userId)
      });
      openProcessingTaskCenter();
    }
  });

  return {
    visible: enabled && !!userId && capability !== undefined,
    state: (capability?.state ??
      (capabilityQuery.isPending ? "loading" : "error")) as
      | ProcessingCapabilityState
      | "loading"
      | "error",
    reason: capability?.reason ?? null,
    submit: mutation.mutateAsync,
    pending: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
    reset: mutation.reset
  };
}
