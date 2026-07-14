import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  GitBranch,
  HardDrive,
  Link2,
  LoaderCircle,
  Plus,
  ShieldCheck
} from "lucide-react";
import {
  ProviderBrandMark,
  type ProviderBrand
} from "@/components/ProviderBrandMark";
import { UiButton, UiInput, UiSelect } from "@/components/ui";
import type { ExternalGitRepositoryVisibility } from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import type { ExternalGitSetupController } from "@/pages/workspace/external-git/useExternalGitSetup";

function ExternalGitSetupFlow({
  connected,
  providerName,
  providerBrand,
  t
}: {
  connected: boolean;
  providerName: string;
  providerBrand: ProviderBrand;
  t: Translator;
}) {
  return (
    <div
      className={`external-git-setup-flow ${connected ? "is-ready" : ""}`}
      aria-hidden
    >
      <span className="external-git-setup-node">
        <HardDrive size={20} />
        <strong>{t("externalGit.workspaceName")}</strong>
      </span>
      <span className="external-git-setup-link">
        <ArrowRight size={16} />
      </span>
      <span className="external-git-setup-node external-git-setup-node-target">
        <ProviderBrandMark brand={providerBrand} size={30} />
        <strong>{providerName}</strong>
      </span>
    </div>
  );
}

function isRepositoryVisibility(
  value: string
): value is ExternalGitRepositoryVisibility {
  return value === "private" || value === "internal" || value === "public";
}

function visibilityLabel(
  visibility: ExternalGitRepositoryVisibility,
  t: Translator
) {
  if (visibility === "private") return t("externalGit.visibilityPrivate");
  if (visibility === "internal") return t("externalGit.visibilityInternal");
  return t("externalGit.visibilityPublic");
}

function RepositorySetupForm({
  controller,
  busy,
  providerName,
  t
}: {
  controller: ExternalGitSetupController;
  busy: boolean;
  providerName: string;
  t: Translator;
}) {
  if (controller.mode === "create") {
    const { form, owners, updateForm, canSubmit, submit } = controller.create;
    return (
      <div className="external-git-setup-form">
        <UiSelect
          label={t("externalGit.owner")}
          value={form.ownerId}
          onChange={(event) => {
            const owner = owners.find(
              (candidate) => candidate.id === event.target.value
            );
            if (owner) {
              updateForm({ ownerId: owner.id, ownerKind: owner.kind });
            }
          }}
          disabled={controller.loadingChoices || busy}
        >
          {owners.map((owner) => (
            <option value={owner.id} key={owner.id}>
              {owner.full_path}
            </option>
          ))}
        </UiSelect>
        <UiInput
          label={t("externalGit.projectName")}
          value={form.name}
          onChange={(event) => updateForm({ name: event.target.value })}
          disabled={busy}
        />
        <UiInput
          label={t("externalGit.projectPath")}
          value={form.path}
          onChange={(event) => updateForm({ path: event.target.value })}
          disabled={busy}
        />
        <UiSelect
          label={t("externalGit.visibility")}
          value={form.visibility}
          onChange={(event) => {
            if (isRepositoryVisibility(event.target.value)) {
              updateForm({ visibility: event.target.value });
            }
          }}
          disabled={busy}
        >
          {controller.supportedVisibilities.map((visibility) => (
            <option value={visibility} key={visibility}>
              {visibilityLabel(visibility, t)}
            </option>
          ))}
        </UiSelect>
        <UiButton
          variant="primary"
          onClick={submit}
          disabled={busy || controller.loadingChoices || !canSubmit}
        >
          {controller.loadingChoices || controller.busy ? (
            <LoaderCircle
              className="external-git-spin"
              size={15}
              aria-hidden
            />
          ) : (
            <Plus size={15} aria-hidden />
          )}
          {controller.busy
            ? t("common.loading")
            : t("externalGit.createAction")}
        </UiButton>
        {controller.hasMoreChoices && (
          <UiButton
            onClick={controller.loadMoreChoices}
            disabled={controller.loadingChoices || busy}
          >
            {controller.loadingChoices
              ? t("externalGit.loadingMore")
              : t("externalGit.loadMore")}
          </UiButton>
        )}
      </div>
    );
  }

  if (controller.mode === "link") {
    const {
      repositoryId,
      repositories,
      selectedRepository,
      setRepositoryId,
      canSubmit,
      submit
    } = controller.link;
    return (
      <div className="external-git-setup-form">
        <UiSelect
          label={t("externalGit.project", { provider: providerName })}
          value={repositoryId}
          onChange={(event) => setRepositoryId(event.target.value)}
          disabled={controller.loadingChoices || busy}
        >
          {repositories.map((repository) => (
            <option value={repository.id} key={repository.id}>
              {repository.full_path}
            </option>
          ))}
        </UiSelect>
        {selectedRepository && (
          <div className="external-git-selected-project">
            <GitBranch size={15} aria-hidden />
            <span>
              <strong>{selectedRepository.full_path}</strong>
              <small>
                {selectedRepository.visibility} ·{" "}
                {selectedRepository.default_branch ||
                  t("externalGit.emptyRepository")}
              </small>
            </span>
          </div>
        )}
        <UiButton
          variant="primary"
          onClick={submit}
          disabled={busy || controller.loadingChoices || !canSubmit}
        >
          {controller.loadingChoices || controller.busy ? (
            <LoaderCircle
              className="external-git-spin"
              size={15}
              aria-hidden
            />
          ) : (
            <Link2 size={15} aria-hidden />
          )}
          {controller.busy
            ? t("common.loading")
            : t("externalGit.linkAction")}
        </UiButton>
        {controller.hasMoreChoices && (
          <UiButton
            onClick={controller.loadMoreChoices}
            disabled={controller.loadingChoices || busy}
          >
            {controller.loadingChoices
              ? t("externalGit.loadingMore")
              : t("externalGit.loadMore")}
          </UiButton>
        )}
      </div>
    );
  }

  return null;
}

export function ExternalGitUnlinkedView({
  connected,
  connectionNeedsReauthorization,
  providerName,
  providerBrand,
  canManageProject,
  canAuthorize,
  authorize,
  setup,
  busy,
  t
}: {
  connected: boolean;
  connectionNeedsReauthorization: boolean;
  providerName: string;
  providerBrand: ProviderBrand;
  canManageProject: boolean;
  canAuthorize: boolean;
  authorize: () => void;
  setup: ExternalGitSetupController;
  busy: boolean;
  t: Translator;
}) {
  if (!connected) {
    return (
      <div className="external-git-onboarding">
        <ExternalGitSetupFlow
          connected={false}
          providerName={providerName}
          providerBrand={providerBrand}
          t={t}
        />
        <div className="external-git-onboarding-copy">
          <strong>
            {t("externalGit.connectAccountTitle", { provider: providerName })}
          </strong>
          <small>
            {t(
              setup.canCreateRepository
                ? "externalGit.signInHint"
                : "externalGit.signInHintExisting",
              { provider: providerName }
            )}
          </small>
        </div>
        {canAuthorize ? (
          <UiButton variant="primary" onClick={authorize}>
            <ShieldCheck size={15} aria-hidden />
            {connectionNeedsReauthorization
              ? t("externalGit.reauthorize", { provider: providerName })
              : t("externalGit.signIn", { provider: providerName })}
          </UiButton>
        ) : (
          <div className="external-git-inline-alert is-warning">
            <AlertTriangle size={16} aria-hidden />
            <span>
              {t("externalGit.authorizationUnavailable", {
                provider: providerName
              })}
            </span>
          </div>
        )}
      </div>
    );
  }

  if (!canManageProject) {
    return (
      <div className="external-git-onboarding">
        <ExternalGitSetupFlow
          connected
          providerName={providerName}
          providerBrand={providerBrand}
          t={t}
        />
        <div className="external-git-onboarding-copy">
          <strong>{t("externalGit.setupTitle", { provider: providerName })}</strong>
          <small>{t("externalGit.draftReadOnly", { provider: providerName })}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="external-git-onboarding">
      <ExternalGitSetupFlow
        connected
        providerName={providerName}
        providerBrand={providerBrand}
        t={t}
      />
      <div className="external-git-onboarding-copy">
        <strong>{t("externalGit.setupTitle", { provider: providerName })}</strong>
        <small>{t("externalGit.draftWarning", { provider: providerName })}</small>
      </div>
      <div className="external-git-setup-choices">
        {setup.canCreateRepository && <button
          type="button"
          className={`external-git-setup-choice ${
            setup.mode === "create" ? "is-selected" : ""
          }`}
          onClick={() =>
            setup.chooseMode(setup.mode === "create" ? "none" : "create")
          }
          disabled={busy}
        >
          <span className="external-git-setup-choice-icon">
            <Plus size={17} aria-hidden />
          </span>
          <span>
            <strong>{t("externalGit.create", { provider: providerName })}</strong>
            <small>{t("externalGit.createDescription")}</small>
          </span>
          <ChevronRight size={15} aria-hidden />
        </button>}
        <button
          type="button"
          className={`external-git-setup-choice ${
            setup.mode === "link" ? "is-selected" : ""
          }`}
          onClick={() =>
            setup.chooseMode(setup.mode === "link" ? "none" : "link")
          }
          disabled={busy}
        >
          <span className="external-git-setup-choice-icon">
            <Link2 size={17} aria-hidden />
          </span>
          <span>
            <strong>{t("externalGit.linkExisting")}</strong>
            <small>{t("externalGit.linkDescription")}</small>
          </span>
          <ChevronRight size={15} aria-hidden />
        </button>
      </div>
      <RepositorySetupForm
        controller={setup}
        busy={busy}
        providerName={providerName}
        t={t}
      />
    </div>
  );
}
