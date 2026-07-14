import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  createExternalGitRepository,
  linkExternalGitRepository,
  listExternalGitRepositoryOwners,
  listExternalGitRepositories,
  type ExternalGitProvider,
  type ExternalGitRepositoryVisibility,
  type RepositoryOwner
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import {
  externalGitErrorMessage,
  projectSlug,
  type ExternalGitSetupMode
} from "@/pages/workspace/external-git/model";

type CreateRepositoryForm = {
  ownerId: string;
  ownerKind: RepositoryOwner["kind"];
  name: string;
  path: string;
  visibility: ExternalGitRepositoryVisibility;
};

export function useExternalGitSetup({
  projectId,
  projectName,
  provider,
  refreshStatus,
  t
}: {
  projectId: string;
  projectName: string;
  provider: ExternalGitProvider | null;
  refreshStatus: () => Promise<void>;
  t: Translator;
}) {
  const [mode, setMode] = useState<ExternalGitSetupMode>("none");
  const [createForm, setCreateForm] = useState<CreateRepositoryForm>(() => ({
    ownerId: "",
    ownerKind: "user",
    name: projectName,
    path: projectSlug(projectName),
    visibility: "private"
  }));
  const [repositoryId, setRepositoryId] = useState("");
  const ownersQuery = useInfiniteQuery({
    queryKey: ["external-git-owners", provider?.id],
    queryFn: ({ pageParam }) =>
      listExternalGitRepositoryOwners(provider?.id ?? "", undefined, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.next_page ?? undefined,
    enabled: mode === "create",
    staleTime: 2 * 60 * 1000
  });
  const repositoriesQuery = useInfiniteQuery({
    queryKey: ["external-git-repositories", provider?.id],
    queryFn: ({ pageParam }) =>
      listExternalGitRepositories(provider?.id ?? "", undefined, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.next_page ?? undefined,
    enabled: mode === "link",
    staleTime: 2 * 60 * 1000
  });
  const owners = useMemo(
    () => ownersQuery.data?.pages.flatMap((page) => page.owners) ?? [],
    [ownersQuery.data?.pages]
  );
  const repositories = useMemo(
    () =>
      repositoriesQuery.data?.pages.flatMap((page) => page.repositories) ?? [],
    [repositoriesQuery.data?.pages]
  );

  useEffect(() => {
    setCreateForm((current) => ({
      ...current,
      name: projectName,
      path: projectSlug(projectName)
    }));
  }, [projectName]);

  useEffect(() => {
    const supported = provider?.capabilities.supported_visibilities ?? [];
    setCreateForm((current) =>
      supported.includes(current.visibility) || !supported[0]
        ? current
        : { ...current, visibility: supported[0] }
    );
  }, [provider]);

  useEffect(() => {
    if (mode !== "create") return;
    setCreateForm((current) =>
      owners.some(
        (owner) =>
          owner.id === current.ownerId && owner.kind === current.ownerKind
      )
        ? current
        : {
            ...current,
            ownerId: owners[0]?.id ?? "",
            ownerKind: owners[0]?.kind ?? "user"
          }
    );
  }, [mode, owners]);

  useEffect(() => {
    if (mode !== "link") return;
    setRepositoryId((current) =>
      repositories.some((repository) => repository.id === current)
        ? current
        : repositories[0]?.id ?? ""
    );
  }, [mode, repositories]);

  const createMutation = useMutation({
    mutationFn: () =>
      createExternalGitRepository(projectId, {
        provider: provider?.id ?? "",
        name: createForm.name.trim(),
        path: createForm.path.trim(),
        owner_id: createForm.ownerId,
        owner_kind: createForm.ownerKind,
        visibility: createForm.visibility
      }),
    onSuccess: async () => {
      setMode("none");
      await refreshStatus();
    }
  });
  const linkMutation = useMutation({
    mutationFn: () =>
      linkExternalGitRepository(projectId, provider?.id ?? "", repositoryId),
    onSuccess: async () => {
      setMode("none");
      await refreshStatus();
    }
  });
  const selectedRepository = useMemo(
    () =>
      repositories.find((repository) => repository.id === repositoryId) ?? null,
    [repositories, repositoryId]
  );

  function chooseMode(nextMode: ExternalGitSetupMode) {
    if (nextMode === "create" && !provider?.capabilities.repository_creation) {
      return;
    }
    createMutation.reset();
    linkMutation.reset();
    setMode(nextMode);
  }

  function updateCreateForm(patch: Partial<CreateRepositoryForm>) {
    setCreateForm((current) => ({ ...current, ...patch }));
  }

  const choiceError =
    mode === "create"
      ? ownersQuery.error
      : mode === "link"
        ? repositoriesQuery.error
        : null;
  const error = choiceError
    ? externalGitErrorMessage(choiceError, t("externalGit.loadFailed"))
    : createMutation.error
      ? externalGitErrorMessage(
          createMutation.error,
          t("externalGit.createFailed")
        )
      : linkMutation.error
        ? externalGitErrorMessage(
            linkMutation.error,
            t("externalGit.linkFailed")
          )
        : null;

  return {
    mode,
    canCreateRepository: provider?.capabilities.repository_creation ?? false,
    supportedVisibilities: provider?.capabilities.supported_visibilities ?? [],
    chooseMode,
    loadingChoices:
      (mode === "create" && ownersQuery.isFetching) ||
      (mode === "link" && repositoriesQuery.isFetching),
    hasMoreChoices:
      (mode === "create" && ownersQuery.hasNextPage) ||
      (mode === "link" && repositoriesQuery.hasNextPage),
    loadMoreChoices: () => {
      if (mode === "create" && ownersQuery.hasNextPage) {
        void ownersQuery.fetchNextPage();
      } else if (mode === "link" && repositoriesQuery.hasNextPage) {
        void repositoriesQuery.fetchNextPage();
      }
    },
    busy: createMutation.isPending || linkMutation.isPending,
    error,
    create: {
      form: createForm,
      owners,
      updateForm: updateCreateForm,
      canSubmit:
        !!createForm.ownerId &&
        !!createForm.name.trim() &&
        !!createForm.path.trim(),
      submit: () => {
        if (
          !createForm.ownerId ||
          !createForm.name.trim() ||
          !createForm.path.trim()
        ) {
          return;
        }
        createMutation.mutate();
      }
    },
    link: {
      repositoryId,
      repositories,
      selectedRepository,
      setRepositoryId,
      canSubmit: !!repositoryId,
      submit: () => {
        if (repositoryId) linkMutation.mutate();
      }
    }
  };
}

export type ExternalGitSetupController = ReturnType<
  typeof useExternalGitSetup
>;
