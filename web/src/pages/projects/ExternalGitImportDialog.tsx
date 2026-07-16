import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  GitBranch,
  HardDrive,
  History,
  LoaderCircle,
  Replace,
  ScanSearch
} from "lucide-react";
import { ProviderBrandMark } from "@/components/ProviderBrandMark";
import { UiButton, UiDialog, UiInput, UiSelect } from "@/components/ui";
import {
  createExternalGitImport,
  externalGitAuthorizationUrl,
  getExternalGitConnectionStatus,
  getExternalGitInboundJob,
  listExternalGitRepositories,
  listExternalGitRepositoryBranches,
  type RemoteBranch,
  type ExternalGitConnectionStatus,
  type ExternalGitInboundJob,
  type ExternalGitProvider,
  type RemoteRepository
} from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type { Translator } from "@/lib/i18n";

const IMPORT_PHASES = ["fetch", "lfs", "validate", "assets", "apply", "revision"] as const;
const EMPTY_REPOSITORIES: RemoteRepository[] = [];
const EMPTY_BRANCHES: RemoteBranch[] = [];

function inboundJobQueryKey(jobId: string) {
  return ["external-git-inbound-job", jobId] as const;
}

function inboundJobRunning(job: ExternalGitInboundJob | null | undefined) {
  return !!job && ["pending", "processing", "retry_wait"].includes(job.state);
}

function inboundJobPollInterval(
  job: ExternalGitInboundJob | null | undefined
): number | false {
  if (!inboundJobRunning(job)) return false;
  const createdAt = Date.parse(job?.created_at ?? "");
  if (!Number.isFinite(createdAt)) return 5000;
  const ageMs = Math.max(0, Date.now() - createdAt);
  if (ageMs < 30_000) return 2000;
  if (ageMs < 120_000) return 5000;
  return 10_000;
}

function phaseIcon(phase: (typeof IMPORT_PHASES)[number]) {
  if (phase === "fetch") return <Download size={15} aria-hidden />;
  if (phase === "lfs") return <GitBranch size={15} aria-hidden />;
  if (phase === "validate") return <ScanSearch size={15} aria-hidden />;
  if (phase === "assets") return <HardDrive size={15} aria-hidden />;
  if (phase === "apply") return <Replace size={15} aria-hidden />;
  return <History size={15} aria-hidden />;
}

export function ExternalGitInboundProgress({ job, t }: { job: ExternalGitInboundJob; t: Translator }) {
  const activeIndex = job.state === "succeeded"
    ? IMPORT_PHASES.length
    : Math.max(0, IMPORT_PHASES.indexOf(job.phase as (typeof IMPORT_PHASES)[number]));
  return (
    <ol className="external-git-import-progress" aria-label={t("externalGit.importProgress") }>
      {IMPORT_PHASES.map((phase, index) => {
        const done = index < activeIndex || job.state === "succeeded";
        const active = index === activeIndex && job.state === "processing";
        return (
          <li className={done ? "is-done" : active ? "is-active" : ""} key={phase}>
            <span>{done ? <Check size={15} aria-hidden /> : phaseIcon(phase)}</span>
            <small>{t(`externalGit.inboundPhase.${phase}`)}</small>
          </li>
        );
      })}
    </ol>
  );
}

export function ExternalGitImportDialog({
  open,
  providers,
  enabledProjectTypes,
  onClose,
  onComplete,
  t
}: {
  open: boolean;
  providers: ExternalGitProvider[];
  enabledProjectTypes: ProjectType[];
  onClose: () => void;
  onComplete: (projectId: string) => Promise<void>;
  t: Translator;
}) {
  const queryClient = useQueryClient();
  const completedJobRef = useRef<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState(
    () => providers[0]?.id ?? ""
  );
  const [repositoryId, setRepositoryId] = useState("");
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [projectType, setProjectType] = useState<"typst" | "latex">("typst");
  const [latexEngine, setLatexEngine] = useState<"xetex" | "pdftex">("xetex");
  const [jobId, setJobId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const showProjectType = enabledProjectTypes.length > 1;
  const connectionQuery = useQuery({
    queryKey: ["external-git-connection", selectedProviderId],
    queryFn: () => getExternalGitConnectionStatus(selectedProviderId),
    enabled: open && !!selectedProviderId,
    retry: false
  });
  const connection: ExternalGitConnectionStatus | null =
    connectionQuery.data ?? null;
  const provider =
    providers.find((candidate) => candidate.id === selectedProviderId) ??
    providers[0] ??
    null;
  const repositoriesQuery = useInfiniteQuery({
    queryKey: ["external-git-repositories", provider?.id],
    queryFn: ({ pageParam }) =>
      listExternalGitRepositories(provider?.id ?? "", undefined, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.next_page ?? undefined,
    enabled: open && !!connection?.connected,
    retry: false
  });
  const repositories =
    repositoriesQuery.data?.pages.flatMap((page) => page.repositories) ??
    EMPTY_REPOSITORIES;
  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === repositoryId) ?? null,
    [repositories, repositoryId]
  );
  const branchesQuery = useInfiniteQuery({
    queryKey: [
      "external-git-repository-branches",
      provider?.id,
      repositoryId
    ],
    queryFn: ({ pageParam }) =>
      listExternalGitRepositoryBranches(
        provider?.id ?? "",
        repositoryId,
        undefined,
        pageParam
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.next_page ?? undefined,
    enabled: open && !!repositoryId && !jobId,
    retry: false
  });
  const branches =
    branchesQuery.data?.pages.flatMap((page) => page.branches) ?? EMPTY_BRANCHES;
  const jobQuery = useQuery({
    queryKey: inboundJobQueryKey(jobId ?? "inactive"),
    queryFn: () => getExternalGitInboundJob(jobId ?? ""),
    enabled: open && !!jobId,
    refetchInterval: (query) => inboundJobPollInterval(query.state.data),
    retry: false
  });
  const job = jobQuery.data ?? null;
  const createImportMutation = useMutation({
    mutationFn: createExternalGitImport
  });
  const loading =
    connectionQuery.isFetching ||
    repositoriesQuery.isFetching ||
    branchesQuery.isFetching;
  const submitting = createImportMutation.isPending;
  const canAuthorize = provider?.authorization_path !== null;

  useEffect(() => {
    if (!open) return;
    if (!providers.some((candidate) => candidate.id === selectedProviderId)) {
      setSelectedProviderId(providers[0]?.id ?? "");
    }
  }, [open, providers, selectedProviderId]);

  useEffect(() => {
    if (!open || jobId) return;
    if (repositories.some((repository) => repository.id === repositoryId)) return;
    setRepositoryId(repositories[0]?.id || "");
  }, [jobId, open, repositories, repositoryId]);

  useEffect(() => {
    if (!open || jobId || !branchesQuery.data || !selectedRepository) return;
    const preferred =
      branches.find(
        (candidate) => candidate.name === selectedRepository.default_branch
      ) ||
      branches.find((candidate) => candidate.default) ||
      branches[0];
    setBranch(preferred?.name || "");
    setName(selectedRepository.name || "");
  }, [
    branches,
    branchesQuery.data,
    jobId,
    open,
    selectedRepository
  ]);

  useEffect(() => {
    if (!open || job?.state !== "succeeded") return;
    if (completedJobRef.current === job.id) return;
    completedJobRef.current = job.id;
    void onComplete(job.project_id).catch((reason: unknown) => {
      completedJobRef.current = null;
      setOperationError(
        reason instanceof Error
          ? reason.message
          : t("externalGit.importStatusFailed")
      );
    });
  }, [job, onComplete, open, t]);

  async function submitImport() {
    if (!provider || !repositoryId || !branch || !name.trim()) return;
    setOperationError(null);
    try {
      const next = await createImportMutation.mutateAsync({
        provider: provider.id,
        repository_id: repositoryId,
        branch,
        name: name.trim(),
        project_type: projectType,
        latex_engine: projectType === "latex" ? latexEngine : undefined
      });
      queryClient.setQueryData(inboundJobQueryKey(next.id), next);
      completedJobRef.current = null;
      setJobId(next.id);
    } catch (reason) {
      setOperationError(
        reason instanceof Error
          ? reason.message
          : t("externalGit.importFailed")
      );
    }
  }

  function authorize() {
    if (!provider) return;
    const url = externalGitAuthorizationUrl(provider, "/projects");
    if (url) window.location.assign(url);
  }

  const loadQueryError =
    connectionQuery.error ?? repositoriesQuery.error ?? branchesQuery.error;
  const error =
    operationError ??
    (jobQuery.error
      ? jobQuery.error instanceof Error
        ? jobQuery.error.message
        : t("externalGit.importStatusFailed")
      : loadQueryError
        ? loadQueryError instanceof Error
          ? loadQueryError.message
          : t("externalGit.loadFailed")
        : null);
  const jobRunning = inboundJobRunning(job);
  if (!provider) {
    return (
      <UiDialog
        open={open}
        title={t("externalGit.importTitle", {
          provider: t("externalGit.providerGeneric")
        })}
        description={t("externalGit.importDescription")}
        onClose={onClose}
        actions={<UiButton onClick={onClose}>{t("common.close")}</UiButton>}
      >
        <div className="external-git-inline-alert is-warning">
          {t("externalGit.notConfigured")}
        </div>
      </UiDialog>
    );
  }
  return (
    <UiDialog
      open={open}
      title={t("externalGit.importTitle", { provider: provider.display_name })}
      description={t("externalGit.importDescription")}
      onClose={onClose}
      actions={
        job ? (
          <>
            {!jobRunning && <UiButton onClick={onClose}>{t("common.close")}</UiButton>}
            {job.state === "failed" || job.state === "paused" ? (
              <UiButton variant="primary" onClick={() => void onComplete(job.project_id)}>
                {t("externalGit.openImportedProject")}
              </UiButton>
            ) : null}
          </>
        ) : connection?.connected ? (
          <>
            <UiButton onClick={onClose} disabled={submitting}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="primary"
              onClick={submitImport}
              disabled={loading || submitting || !connection?.connected || !repositoryId || !branch || !name.trim()}
            >
              {submitting ? <LoaderCircle className="external-git-spin" size={15} aria-hidden /> : <Download size={15} aria-hidden />}
              {submitting ? t("common.loading") : t("externalGit.importAction")}
            </UiButton>
          </>
        ) : (
          <UiButton onClick={onClose}>{t("common.close")}</UiButton>
        )
      }
    >
      <div
        className="external-git-provider-shell"
        data-provider-brand={provider.brand}
      >
        <div className="external-git-provider-identity">
          <ProviderBrandMark brand={provider.brand} size={36} />
          <span>
            <strong>{provider.display_name}</strong>
            <small>{provider.base_url}</small>
          </span>
        </div>
        {providers.length > 1 && !job && (
          <UiSelect
            label={t("externalGit.providerSelect")}
            value={provider.id}
            onChange={(event) => {
              setSelectedProviderId(event.target.value);
              setRepositoryId("");
              setBranch("");
            }}
            disabled={submitting}
          >
            {providers.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.display_name}
              </option>
            ))}
          </UiSelect>
        )}
        {!connection?.connected && !loading ? (
          <div className="external-git-import-auth">
            <strong>
              {t("externalGit.connectAccountTitle", {
                provider: provider.display_name
              })}
            </strong>
            {canAuthorize ? (
              <UiButton variant="primary" onClick={authorize}>
                {t("externalGit.signIn", { provider: provider.display_name })}
              </UiButton>
            ) : (
              <small>
                {t("externalGit.authorizationUnavailable", {
                  provider: provider.display_name
                })}
              </small>
            )}
          </div>
        ) : job ? (
          <div className="external-git-import-job" role="status">
            <div className="external-git-import-job-heading">
              {jobRunning ? (
                <LoaderCircle
                  className="external-git-spin"
                  size={18}
                  aria-hidden
                />
              ) : job.state === "succeeded" ? (
                <Check size={18} aria-hidden />
              ) : (
                <GitBranch size={18} aria-hidden />
              )}
              <span>
                <strong>{t(`externalGit.inboundState.${job.state}`)}</strong>
                <small>{job.source_branch}</small>
              </span>
            </div>
            <ExternalGitInboundProgress job={job} t={t} />
            {job.last_error && (
              <div className="external-git-inline-alert is-danger">
                {t(`externalGit.error.${job.last_error}`)}
              </div>
            )}
            {job.state === "retry_wait" && job.next_retry_at && (
              <small className="muted">
                {t("externalGit.retryAt", {
                  time: new Date(job.next_retry_at).toLocaleTimeString()
                })}
              </small>
            )}
          </div>
        ) : connection?.connected ? (
          <div className="external-git-import-form">
            <UiSelect
              label={t("externalGit.project", {
                provider: provider.display_name
              })}
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
              disabled={loading || submitting}
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.full_path}
                </option>
              ))}
            </UiSelect>
            {repositoriesQuery.hasNextPage && (
              <UiButton
                onClick={() => void repositoriesQuery.fetchNextPage()}
                disabled={repositoriesQuery.isFetchingNextPage || submitting}
              >
                {repositoriesQuery.isFetchingNextPage
                  ? t("externalGit.loadingMore")
                  : t("externalGit.loadMore")}
              </UiButton>
            )}
            <UiSelect
              label={t("externalGit.sourceBranch")}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              disabled={loading || submitting || !selectedRepository}
            >
              {branches.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
            </UiSelect>
            {branchesQuery.hasNextPage && (
              <UiButton
                onClick={() => void branchesQuery.fetchNextPage()}
                disabled={branchesQuery.isFetchingNextPage || submitting}
              >
                {branchesQuery.isFetchingNextPage
                  ? t("externalGit.loadingMore")
                  : t("externalGit.loadMore")}
              </UiButton>
            )}
            <UiInput
              label={t("projects.namePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
            />
            {showProjectType && (
              <UiSelect
                label={t("settings.projectType")}
                value={projectType}
                onChange={(event) =>
                  setProjectType(
                    event.target.value === "latex" ? "latex" : "typst"
                  )
                }
              >
                <option value="typst">{t("settings.projectTypeTypst")}</option>
                <option value="latex">{t("settings.projectTypeLatex")}</option>
              </UiSelect>
            )}
            {showProjectType && projectType === "latex" && (
              <UiSelect
                label={t("settings.latexEngine")}
                value={latexEngine}
                onChange={(event) =>
                  setLatexEngine(
                    event.target.value === "pdftex" ? "pdftex" : "xetex"
                  )
                }
              >
                <option value="xetex">XeTeX</option>
                <option value="pdftex">pdfTeX</option>
              </UiSelect>
            )}
            {loading && <small className="muted">{t("common.loading")}</small>}
            {repositories.length === 0 && !loading && (
              <small className="muted">{t("externalGit.noRepositories")}</small>
            )}
          </div>
        ) : null}
        {error && (
          <div className="external-git-inline-alert is-danger" role="alert">
            {error}
          </div>
        )}
      </div>
    </UiDialog>
  );
}
