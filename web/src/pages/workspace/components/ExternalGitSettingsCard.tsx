import { AlertTriangle } from "lucide-react";
import {
  ProviderBrandMark,
  type ProviderBrand
} from "@/components/ProviderBrandMark";
import { UiCard, UiSectionHeading, UiSelect, UiTooltip } from "@/components/ui";
import { useEffect, useState } from "react";
import "@/pages/external-git.css";
import {
  externalGitAuthorizationUrl,
  type ExternalGitProvider
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";
import { ExternalGitDialogs } from "@/pages/workspace/external-git/ExternalGitDialogs";
import {
  ExternalGitLinkedView,
  ExternalGitSyncStateIcon
} from "@/pages/workspace/external-git/ExternalGitLinkedView";
import { ExternalGitUnlinkedView } from "@/pages/workspace/external-git/ExternalGitSetupView";
import {
  externalGitErrorMessage,
  externalGitStatusDescription,
  externalGitStatusTone
} from "@/pages/workspace/external-git/model";
import { useExternalGitInboundSync } from "@/pages/workspace/external-git/useExternalGitInboundSync";
import { useExternalGitProjectActions } from "@/pages/workspace/external-git/useExternalGitProjectActions";
import { useExternalGitSetup } from "@/pages/workspace/external-git/useExternalGitSetup";
import { useExternalGitStatus } from "@/pages/workspace/external-git/useExternalGitStatus";

export function ExternalGitSettingsCard({
  projectId,
  projectName,
  canManageProject,
  providers,
  t
}: {
  projectId: string;
  projectName: string;
  canManageProject: boolean;
  providers: ExternalGitProvider[];
  t: Translator;
}) {
  const [selectedProviderId, setSelectedProviderId] = useState(
    () => providers[0]?.id ?? ""
  );
  const statusController = useExternalGitStatus(
    projectId,
    providers.length > 0,
    selectedProviderId
  );
  const { connection, status } = statusController;
  const boundProviderId = status?.linked ? status.provider : null;
  const provider = boundProviderId
    ? providers.find((candidate) => candidate.id === boundProviderId) ?? null
    : providers.find((candidate) => candidate.id === selectedProviderId) ??
      providers[0] ??
      null;
  const providerName = provider?.display_name || t("externalGit.providerGeneric");
  const providerBrand: ProviderBrand = provider?.brand ?? "identity";
  const canAuthorize = provider?.authorization_path !== null;
  useEffect(() => {
    if (boundProviderId && providers.some((candidate) => candidate.id === boundProviderId)) {
      setSelectedProviderId(boundProviderId);
    } else if (!providers.some((candidate) => candidate.id === selectedProviderId)) {
      setSelectedProviderId(providers[0]?.id ?? "");
    }
  }, [boundProviderId, providers, selectedProviderId]);
  const setup = useExternalGitSetup({
    projectId,
    projectName,
    provider,
    refreshStatus: statusController.refresh,
    t
  });
  const projectActions = useExternalGitProjectActions({
    projectId,
    refreshStatus: statusController.refresh,
    t
  });
  const inboundSync = useExternalGitInboundSync({
    projectId,
    status: statusController.status,
    refreshStatus: statusController.refresh,
    t
  });
  const busy = setup.busy || projectActions.busy || inboundSync.busy;
  const statusError = statusController.error
    ? externalGitErrorMessage(
        statusController.error,
        t("externalGit.loadFailed")
      )
    : null;
  const error = setup.error || projectActions.error || inboundSync.error || statusError;

  const authorize = () => {
    if (!canAuthorize || !provider) return;
    const returnTo = `/project/${projectId}`;
    const url = externalGitAuthorizationUrl(provider, returnTo);
    if (url) window.location.assign(url);
  };
  const statusSummary = status
    ? `${t(`externalGit.state.${status.state}`)}: ${externalGitStatusDescription(
        status,
        providerName,
        t
      )}`
    : null;
  const header = (
    <UiSectionHeading
      className="external-git-card-heading"
      icon={<ProviderBrandMark brand={providerBrand} size={20} />}
      title={t("externalGit.title")}
      description={t("externalGit.subtitle")}
      actions={status && statusSummary ? (
        <UiTooltip
          content={statusSummary}
          className="external-git-status-tooltip"
          triggerTabIndex={0}
          triggerAriaLabel={statusSummary}
        >
          <span
            className={`external-git-header-status is-${externalGitStatusTone(
              status.state
            )}`}
            role="status"
            aria-label={statusSummary}
          >
            <ExternalGitSyncStateIcon state={status.state} />
          </span>
        </UiTooltip>
      ) : undefined}
    />
  );

  if (!connection || !status) {
    return (
      <UiCard
        className="settings-section-card external-git-card"
        data-provider-brand={providerBrand}
        contentLayout="column gap:md pad:md align:horizontal-stretch"
      >
        {header}
        <div className="external-git-loading" aria-label={t("common.loading")}>
          <span />
          <span />
          <span />
        </div>
        {error && (
          <div className="external-git-inline-alert is-danger">{error}</div>
        )}
      </UiCard>
    );
  }

  return (
    <>
      <UiCard
        className="settings-section-card external-git-card"
        data-provider-brand={providerBrand}
        contentLayout="column gap:md pad:md align:horizontal-stretch"
      >
        {header}
        {!connection.configured ? (
          <div className="external-git-inline-alert is-warning">
            <AlertTriangle size={16} aria-hidden />
            <span>{t("externalGit.notConfigured")}</span>
          </div>
        ) : status.linked ? (
          <ExternalGitLinkedView
            status={status}
            providerName={providerName}
            providerBrand={providerBrand}
            canManageProject={canManageProject}
            canAuthorize={canAuthorize}
            authorize={authorize}
            projectActions={projectActions}
            inboundSync={inboundSync}
            busy={busy}
            t={t}
          />
        ) : (
          <>
            {providers.length > 1 && provider && (
              <UiSelect
                label={t("externalGit.providerSelect")}
                value={provider.id}
                onChange={(event) => setSelectedProviderId(event.target.value)}
                disabled={busy}
              >
                {providers.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.display_name}
                  </option>
                ))}
              </UiSelect>
            )}
            <ExternalGitUnlinkedView
              connected={connection.connected}
              connectionNeedsReauthorization={
                connection.status === "reauth_required"
              }
              providerName={providerName}
              providerBrand={providerBrand}
              canManageProject={canManageProject}
              canAuthorize={canAuthorize}
              authorize={authorize}
              setup={setup}
              busy={busy}
              t={t}
            />
          </>
        )}
        {error && (
          <div className="external-git-inline-alert is-danger" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span>{error}</span>
          </div>
        )}
      </UiCard>
      <ExternalGitDialogs
        providerName={providerName}
        projectActions={projectActions}
        inboundSync={inboundSync}
        busy={busy}
        t={t}
      />
    </>
  );
}
