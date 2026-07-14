import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  Activity,
  Ban,
  CalendarDays,
  Check,
  CheckCircle2,
  ClockAlert,
  Copy,
  Hourglass,
  KeyRound,
  Link2,
  Plus,
  ShieldCheck,
  ShieldX,
  TriangleAlert
} from "lucide-react";
import { ProviderBrandMark } from "@/components/ProviderBrandMark";
import {
  UiButton,
  UiCard,
  UiDialog,
  UiHelpTooltip,
  UiIconButton,
  UiInput,
  UiSelect,
  UiTooltip
} from "@/components/ui";
import {
  createPersonalAccessToken,
  disconnectExternalGitConnection,
  externalGitAuthorizationUrl,
  getExternalGitConnectionStatus,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  type ExternalGitConnectionStatus,
  type ExternalGitProvider,
  type PersonalAccessTokenInfo
} from "@/lib/api";
import { formatDateTime, type Translator, type UiLocale } from "@/lib/i18n";
import { safeReturnPath } from "@/lib/experience";

type CreatePatReveal = {
  token: string;
  token_prefix: string;
  label: string;
  expires_at?: string | null;
  created_at?: string;
};

type TokenState = "active" | "expired" | "revoked";
const EMPTY_TOKENS: PersonalAccessTokenInfo[] = [];

function tokenState(token: PersonalAccessTokenInfo): TokenState {
  if (token.revoked_at) return "revoked";
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) return "expired";
  return "active";
}

function TokenMetadata({
  icon,
  label,
  value,
  exactValue
}: {
  icon: ReactNode;
  label: string;
  value: string;
  exactValue?: string;
}) {
  const description = `${label}: ${exactValue || value}`;
  return (
    <UiTooltip content={description} className="profile-token-meta-tooltip">
      <span className="profile-token-meta" aria-label={description}>
        {icon}
        <span>{value}</span>
      </span>
    </UiTooltip>
  );
}

export function ProfilePage({
  externalGitProviders,
  locale,
  t
}: {
  externalGitProviders: ExternalGitProvider[];
  locale: UiLocale;
  t: Translator;
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const accountLinkParameters = new URLSearchParams(location.search);
  const accountLinkProviderId = accountLinkParameters.get("connect_provider");
  const accountLinkReturnTo = safeReturnPath(
    accountLinkParameters.get("return_to")
  );
  const [tokenLabel, setTokenLabel] = useState(() => t("profile.defaultTokenLabel"));
  const [tokenExpiryPreset, setTokenExpiryPreset] = useState<"never" | "7d" | "30d" | "90d" | "custom">("30d");
  const [tokenCustomExpiresAtLocal, setTokenCustomExpiresAtLocal] = useState("");
  const [newToken, setNewToken] = useState<CreatePatReveal | null>(null);
  const [revokeCandidateId, setRevokeCandidateId] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [disconnectCandidate, setDisconnectCandidate] = useState<{
    provider: ExternalGitProvider;
    connection: ExternalGitConnectionStatus;
  } | null>(null);
  const connectionQueries = useQueries({
    queries: externalGitProviders.map((provider) => ({
      queryKey: ["external-git-connection", provider.id],
      queryFn: () => getExternalGitConnectionStatus(provider.id),
      retry: false
    }))
  });
  const tokensQuery = useQuery({
    queryKey: ["personal-access-tokens"],
    queryFn: listPersonalAccessTokens,
    retry: false
  });
  const tokens = tokensQuery.data?.tokens ?? EMPTY_TOKENS;
  const createTokenMutation = useMutation({
    mutationFn: createPersonalAccessToken,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["personal-access-tokens"] })
  });
  const revokeTokenMutation = useMutation({
    mutationFn: revokePersonalAccessToken,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["personal-access-tokens"] })
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnectExternalGitConnection,
    onSuccess: async (_data, providerId) => {
      await queryClient.invalidateQueries({
        queryKey: ["external-git-connection", providerId]
      });
    }
  });
  const creating = createTokenMutation.isPending;
  const busyTokenId = revokeTokenMutation.isPending
    ? (revokeTokenMutation.variables ?? null)
    : null;
  const connectionQueryError = connectionQueries.find(
    (query) => query.error
  )?.error;
  const error =
    operationError ??
    (disconnectMutation.error instanceof Error
      ? disconnectMutation.error.message
      : null) ??
    (connectionQueryError instanceof Error
      ? connectionQueryError.message
      : null) ??
    (tokensQuery.error
      ? tokensQuery.error instanceof Error
        ? tokensQuery.error.message
        : t("profile.loadFailed")
      : null);

  async function disconnectProvider() {
    if (!disconnectCandidate) return;
    try {
      setOperationError(null);
      await disconnectMutation.mutateAsync(disconnectCandidate.provider.id);
      setDisconnectCandidate(null);
    } catch (reason) {
      setOperationError(
        reason instanceof Error
          ? reason.message
          : t("profile.externalGitDisconnectFailed")
      );
    }
  }

  function formatOptionalDate(value: string | null) {
    if (!value) return t("profile.never");
    return formatDateTime(locale, value);
  }

  function formatCompactDate(value: string | null, fallback: string) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  }

  function computeExpiresAt(): string | null {
    if (tokenExpiryPreset === "never") return null;
    if (tokenExpiryPreset === "custom") {
      if (!tokenCustomExpiresAtLocal.trim()) return null;
      const parsed = new Date(tokenCustomExpiresAtLocal);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(t("profile.invalidExpiry"));
      }
      return parsed.toISOString();
    }
    const days = tokenExpiryPreset === "7d" ? 7 : tokenExpiryPreset === "30d" ? 30 : 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createToken() {
    if (!tokenLabel.trim()) return;
    try {
      setOperationError(null);
      const created = await createTokenMutation.mutateAsync({
        label: tokenLabel.trim(),
        expires_at: computeExpiresAt()
      });
      setNewToken({
        token: created.token,
        token_prefix: created.token_prefix,
        label: created.label,
        expires_at: created.expires_at,
        created_at: created.created_at
      });
      setCopiedToken(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("profile.createFailed");
      setOperationError(message);
    }
  }

  async function copyNewToken() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken.token);
    setCopiedToken(true);
    window.setTimeout(() => setCopiedToken(false), 1200);
  }

  async function copyTokenPrefix(token: PersonalAccessTokenInfo) {
    await navigator.clipboard.writeText(token.token_prefix);
    setCopiedPrefixId(token.id);
    window.setTimeout(() => setCopiedPrefixId((current) => (current === token.id ? null : current)), 1200);
  }

  async function revokeToken(tokenId: string) {
    try {
      setOperationError(null);
      await revokeTokenMutation.mutateAsync(tokenId);
      setRevokeCandidateId(null);
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : t("profile.revokeFailed")
      );
    }
  }

  const revokeCandidate = tokens.find((token) => token.id === revokeCandidateId) ?? null;

  return (
    <section className="app-page profile-page" nve-layout="column gap:lg pad:md @md|pad:xl">
      <header className="profile-page-header">
        <span className="profile-page-icon" aria-hidden>
          <ShieldCheck size={24} />
        </span>
        <h1 nve-text="heading xl">{t("profile.title")}</h1>
      </header>

      <div className="profile-content">
        {externalGitProviders.length > 0 ? (
          <UiCard className="profile-provider-card">
            <div className="profile-card-header">
              <span className="profile-card-icon" aria-hidden>
                <Link2 size={18} />
              </span>
              <div>
                <h2>{t("profile.externalGitTitle")}</h2>
                <p>{t("profile.externalGitDescription")}</p>
              </div>
            </div>
            <div className="profile-provider-list">
              {accountLinkProviderId ? (
                <div className="profile-provider-link-notice" role="status">
                  {t("profile.externalGitCompleteLink")}
                </div>
              ) : null}
              {externalGitProviders.map((provider, index) => {
                const query = connectionQueries[index];
                const connection = query?.data ?? null;
                const authorizationUrl = externalGitAuthorizationUrl(
                  provider,
                  provider.id === accountLinkProviderId
                    ? accountLinkReturnTo
                    : "/profile"
                );
                const restriction = connection?.disconnect_restriction;
                const restrictionLabel = restriction
                  ? t(`profile.externalGitDisconnectRestriction.${restriction}`)
                  : null;
                return (
                  <article
                    className="profile-provider-item"
                    data-provider-brand={provider.brand}
                    key={provider.id}
                  >
                    <ProviderBrandMark brand={provider.brand} size={30} />
                    <span className="profile-provider-identity">
                      <strong>{provider.display_name}</strong>
                      <small>
                        {connection?.bound
                          ? connection.username || connection.account_id
                          : provider.base_url}
                      </small>
                    </span>
                    <span
                      className={`profile-provider-state ${
                        connection?.connected
                          ? "is-connected"
                          : connection?.bound
                            ? "is-warning"
                            : "is-disconnected"
                      }`}
                    >
                      {query?.isFetching
                        ? t("common.loading")
                        : connection?.connected
                          ? t("profile.externalGitConnected")
                          : connection?.bound
                            ? t("profile.externalGitReconnectRequired")
                            : t("profile.externalGitNotConnected")}
                    </span>
                    <span className="profile-provider-actions">
                      {authorizationUrl && !connection?.connected ? (
                        <UiButton
                          size="sm"
                          onClick={() => window.location.assign(authorizationUrl)}
                        >
                          {connection?.bound
                            ? t("profile.externalGitReconnect")
                            : t("profile.externalGitConnect")}
                        </UiButton>
                      ) : null}
                      {connection?.bound ? (
                        <UiButton
                          size="sm"
                          variant="danger"
                          disabled={
                            !connection.can_disconnect ||
                            disconnectMutation.isPending
                          }
                          title={restrictionLabel ?? undefined}
                          onClick={() =>
                            setDisconnectCandidate({ provider, connection })
                          }
                        >
                          {t("profile.externalGitDisconnect")}
                        </UiButton>
                      ) : null}
                    </span>
                    {restrictionLabel ? (
                      <small className="profile-provider-restriction">
                        {restrictionLabel}
                      </small>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </UiCard>
        ) : null}

        <UiCard className="profile-token-create-card">
          <div className="profile-card-header">
            <span className="profile-card-icon" aria-hidden>
              <KeyRound size={18} />
            </span>
            <div>
              <h2>{t("profile.createTitle")}</h2>
            </div>
            <UiHelpTooltip content={t("profile.tokensHint")} />
          </div>

          <div className="profile-token-form">
            <UiInput
              label={t("profile.tokenLabel")}
              value={tokenLabel}
              onChange={(event) => setTokenLabel(event.target.value)}
              placeholder={t("profile.tokenLabelPlaceholder")}
            />
            <UiSelect
              label={t("profile.expires")}
              value={tokenExpiryPreset}
              onChange={(event) =>
                setTokenExpiryPreset(event.target.value as "never" | "7d" | "30d" | "90d" | "custom")
              }
            >
              <option value="never">{t("profile.expNever")}</option>
              <option value="7d">{t("profile.exp7d")}</option>
              <option value="30d">{t("profile.exp30d")}</option>
              <option value="90d">{t("profile.exp90d")}</option>
              <option value="custom">{t("profile.expCustom")}</option>
            </UiSelect>
            {tokenExpiryPreset === "custom" ? (
              <UiInput
                className="profile-custom-expiry"
                label={t("profile.customExpiry")}
                type="datetime-local"
                value={tokenCustomExpiresAtLocal}
                onChange={(event) => setTokenCustomExpiresAtLocal(event.target.value)}
              />
            ) : null}
          </div>

          <div className="profile-form-actions">
            <UiButton variant="primary" onClick={createToken} disabled={creating || !tokenLabel.trim()}>
              <span className="profile-button-content">
                {creating ? null : <Plus size={15} aria-hidden />}
                {creating ? t("profile.creating") : t("profile.createToken")}
              </span>
            </UiButton>
          </div>
        </UiCard>

        {newToken ? (
          <UiCard className="profile-new-token-card">
            <div className="profile-new-token-heading">
              <span className="profile-warning-icon" aria-hidden>
                <TriangleAlert size={18} />
              </span>
              <div>
                <h2>{t("profile.newTokenShownOnce")}</h2>
                <p>{t("profile.newTokenWarning")}</p>
              </div>
            </div>
            <div className="profile-token-reveal-row">
              <code className="token-reveal">{newToken.token}</code>
              <UiButton size="sm" variant={copiedToken ? "secondary" : "primary"} onClick={copyNewToken}>
                <span className="profile-button-content">
                  {copiedToken ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                  {copiedToken ? t("share.copied") : t("profile.copyToken")}
                </span>
              </UiButton>
            </div>
            <div className="profile-new-token-meta">
              <TokenMetadata
                icon={<KeyRound size={13} aria-hidden />}
                label={t("profile.tokenLabel")}
                value={newToken.label}
              />
              <TokenMetadata
                icon={<Hourglass size={13} aria-hidden />}
                label={t("profile.expires")}
                value={formatCompactDate(newToken.expires_at || null, t("profile.never"))}
                exactValue={formatOptionalDate(newToken.expires_at || null)}
              />
            </div>
          </UiCard>
        ) : null}

        {error ? (
          <div className="profile-error" role="alert">
            <TriangleAlert size={15} aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}

        <UiCard className="profile-token-list-card">
          <div className="profile-card-header">
            <span className="profile-card-icon" aria-hidden>
              <ShieldCheck size={18} />
            </span>
            <div>
              <h2>{t("profile.tokenList")}</h2>
            </div>
            <span className="profile-token-count" aria-label={t("profile.tokenCount", { count: tokens.length })}>
              {tokens.length}
            </span>
          </div>

          <div className="profile-token-list">
            {tokens.map((token) => {
              const state = tokenState(token);
              const stateLabel =
                state === "revoked"
                  ? `${t("profile.statusRevokedAt")} ${formatOptionalDate(token.revoked_at)}`
                  : state === "expired"
                    ? t("profile.statusExpired")
                    : t("profile.statusActive");
              return (
                <article key={token.id} className={`profile-token-item ${state}`}>
                  <div className="profile-token-item-main">
                    <UiTooltip
                      content={stateLabel}
                      className="profile-token-status-tooltip"
                      triggerTabIndex={0}
                      triggerAriaLabel={stateLabel}
                      triggerRole="img"
                    >
                      <span className={`profile-token-status ${state}`}>
                        {state === "active" ? (
                          <CheckCircle2 size={16} aria-hidden />
                        ) : state === "expired" ? (
                          <ClockAlert size={16} aria-hidden />
                        ) : (
                          <ShieldX size={16} aria-hidden />
                        )}
                      </span>
                    </UiTooltip>
                    <div className="profile-token-identity">
                      <strong>{token.label}</strong>
                      <code>{token.token_prefix}</code>
                    </div>
                    <div className="profile-token-actions">
                      <UiIconButton
                        tooltip={copiedPrefixId === token.id ? t("share.copied") : t("profile.copyPrefix")}
                        label={t("profile.copyPrefix")}
                        onClick={() => copyTokenPrefix(token)}
                      >
                        {copiedPrefixId === token.id ? <Check size={15} /> : <Copy size={15} />}
                      </UiIconButton>
                      <UiIconButton
                        tooltip={token.revoked_at ? t("profile.revoked") : t("common.revoke")}
                        label={token.revoked_at ? t("profile.revoked") : t("common.revoke")}
                        className="profile-token-revoke"
                        disabled={!!token.revoked_at || busyTokenId === token.id}
                        onClick={() => setRevokeCandidateId(token.id)}
                      >
                        <Ban size={15} />
                      </UiIconButton>
                    </div>
                  </div>
                  <div className="profile-token-metadata">
                    <TokenMetadata
                      icon={<CalendarDays size={13} aria-hidden />}
                      label={t("profile.created")}
                      value={formatCompactDate(token.created_at, token.created_at)}
                      exactValue={formatDateTime(locale, token.created_at)}
                    />
                    <TokenMetadata
                      icon={<Hourglass size={13} aria-hidden />}
                      label={t("profile.expires")}
                      value={formatCompactDate(token.expires_at, t("profile.never"))}
                      exactValue={formatOptionalDate(token.expires_at)}
                    />
                    <TokenMetadata
                      icon={<Activity size={13} aria-hidden />}
                      label={t("profile.lastUsed")}
                      value={formatCompactDate(token.last_used_at, t("profile.notUsed"))}
                      exactValue={token.last_used_at ? formatDateTime(locale, token.last_used_at) : t("profile.notUsed")}
                    />
                  </div>
                </article>
              );
            })}

            {tokens.length === 0 ? (
              <div className="profile-token-empty">
                <span className="profile-token-empty-icon" aria-hidden>
                  <KeyRound size={22} />
                </span>
                <strong>{t("profile.noTokens")}</strong>
              </div>
            ) : null}
          </div>
        </UiCard>
      </div>

      <UiDialog
        open={!!disconnectCandidate}
        title={t("profile.externalGitDisconnectConfirmTitle")}
        description={
          disconnectCandidate
            ? t("profile.externalGitDisconnectConfirm", {
                provider: disconnectCandidate.provider.display_name
              })
            : undefined
        }
        onClose={() => setDisconnectCandidate(null)}
        actions={
          <>
            <UiButton onClick={() => setDisconnectCandidate(null)}>
              {t("common.cancel")}
            </UiButton>
            <UiButton
              variant="danger"
              disabled={disconnectMutation.isPending}
              onClick={() => void disconnectProvider()}
            >
              {t("profile.externalGitDisconnect")}
            </UiButton>
          </>
        }
      />

      <UiDialog
        open={!!revokeCandidate}
        title={t("profile.revokeConfirmTitle")}
        description={revokeCandidate ? t("profile.revokeConfirmHint", { label: revokeCandidate.label }) : undefined}
        onClose={() => setRevokeCandidateId(null)}
        actions={
          <>
            <UiButton onClick={() => setRevokeCandidateId(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="danger"
              disabled={!revokeCandidate || busyTokenId === revokeCandidate.id}
              onClick={() => revokeCandidate && revokeToken(revokeCandidate.id)}
            >
              {t("common.revoke")}
            </UiButton>
          </>
        }
      />
    </section>
  );
}
