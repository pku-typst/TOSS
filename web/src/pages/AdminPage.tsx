import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import "@/pages/admin.css";
import {
  Building2,
  KeyRound,
  LoaderCircle,
  Network,
  Plus,
  Save,
  ShieldCheck,
  ShieldCog,
  Trash2,
  UserRoundPlus,
  UsersRound
} from "lucide-react";
import { applicationBootstrapQueryKey } from "@/applicationSession";
import {
  UiBadge,
  UiButton,
  UiCard,
  UiCheckbox,
  UiDialog,
  UiEmptyState,
  UiHelpTooltip,
  UiIconButton,
  UiInput,
  UiPageHeading,
  UiSectionHeading,
  UiSelect
} from "@/components/ui";
import {
  createOrganization,
  deleteOrgGroupRoleMapping,
  getAdminAuthSettings,
  listOrganizations,
  listOrgGroupRoleMappings,
  upsertAdminAuthSettings,
  upsertOrgGroupRoleMapping,
  type AdminAuthSettings,
  type Organization,
  type OrganizationMembershipRole,
  type OrgGroupRoleMapping
} from "@/lib/api";
import type { Translator } from "@/lib/i18n";

type BusyAction = "auth" | "organization" | "mapping" | "remove" | null;
const EMPTY_ORGANIZATIONS: Organization[] = [];
const EMPTY_MAPPINGS: OrgGroupRoleMapping[] = [];

export function AdminPage({ t }: { t: Translator }) {
  const queryClient = useQueryClient();
  const roleOptions: Array<{ value: OrganizationMembershipRole; label: string }> = [
    { value: "owner", label: t("admin.roleOwner") },
    { value: "member", label: t("admin.roleMember") }
  ];
  const [orgId, setOrgId] = useState("");
  const [newOrganizationName, setNewOrganizationName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<OrganizationMembershipRole>("member");
  const [settings, setSettings] = useState<AdminAuthSettings | null>(null);
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["admin-overview"],
    queryFn: async () => {
      const [organizations, authSettings] = await Promise.all([
        listOrganizations(),
        getAdminAuthSettings()
      ]);
      return { organizations: organizations.organizations, authSettings };
    },
    retry: false
  });
  const organizations: Organization[] =
    overviewQuery.data?.organizations ?? EMPTY_ORGANIZATIONS;
  const mappingsQuery = useQuery({
    queryKey: ["admin-group-mappings", orgId],
    queryFn: () => listOrgGroupRoleMappings(orgId),
    enabled: !!orgId,
    retry: false
  });
  const mappings: OrgGroupRoleMapping[] =
    mappingsQuery.data ?? EMPTY_MAPPINGS;

  useEffect(() => {
    const authSettings = overviewQuery.data?.authSettings;
    if (!authSettings) return;
    setSettings(authSettings);
    setDiscoveryUrl(authSettings.oidc_issuer || "");
  }, [overviewQuery.data?.authSettings]);

  useEffect(() => {
    if (organizations.some((organization) => organization.id === orgId)) return;
    setOrgId(organizations[0]?.id || "");
  }, [orgId, organizations]);

  const saveAuthMutation = useMutation({
    mutationFn: upsertAdminAuthSettings,
    onSuccess: async (updated) => {
      queryClient.setQueryData<{
        organizations: Organization[];
        authSettings: AdminAuthSettings;
      }>(["admin-overview"], (current) =>
        current ? { ...current, authSettings: updated } : current
      );
      setSettings(updated);
      setDiscoveryUrl(updated.oidc_issuer || "");
      await queryClient.invalidateQueries({
        queryKey: applicationBootstrapQueryKey
      });
    }
  });
  const createOrganizationMutation = useMutation({
    mutationFn: createOrganization,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["signed-in-context"] })
      ])
  });
  const saveMappingMutation = useMutation({
    mutationFn: (input: {
      organizationId: string;
      groupName: string;
      role: OrganizationMembershipRole;
    }) =>
      upsertOrgGroupRoleMapping(input.organizationId, {
        group_name: input.groupName,
        role: input.role
      }),
    onSuccess: (_mapping, input) =>
      queryClient.invalidateQueries({
        queryKey: ["admin-group-mappings", input.organizationId]
      })
  });
  const removeMappingMutation = useMutation({
    mutationFn: (input: { organizationId: string; groupName: string }) =>
      deleteOrgGroupRoleMapping(input.organizationId, input.groupName),
    onSuccess: (_result, input) =>
      queryClient.invalidateQueries({
        queryKey: ["admin-group-mappings", input.organizationId]
      })
  });
  const busyAction: BusyAction = saveAuthMutation.isPending
    ? "auth"
    : createOrganizationMutation.isPending
      ? "organization"
      : saveMappingMutation.isPending
        ? "mapping"
        : removeMappingMutation.isPending
          ? "remove"
          : null;
  const queryError = overviewQuery.error ?? mappingsQuery.error;
  const error =
    operationError ??
    (queryError
      ? queryError instanceof Error
        ? queryError.message
        : t("admin.loadFailed")
      : null);

  async function saveAuthSettings() {
    if (!settings) return;
    try {
      setOperationError(null);
      await saveAuthMutation.mutateAsync({
        allow_local_login: settings.allow_local_login,
        allow_local_registration: settings.allow_local_registration,
        allow_oidc: settings.allow_oidc,
        anonymous_mode: settings.anonymous_mode || "off",
        site_name: settings.site_name || null,
        announcement: settings.announcement || null,
        oidc_discovery_url: discoveryUrl || null,
        oidc_client_id: settings.oidc_client_id || null,
        oidc_client_secret: settings.oidc_client_secret || null,
        oidc_redirect_uri: settings.oidc_redirect_uri || null,
        oidc_groups_claim: settings.oidc_groups_claim || "groups"
      });
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : t("admin.saveAuthFailed")
      );
    }
  }

  async function createOrganizationAction() {
    const name = newOrganizationName.trim();
    if (!name) return;
    try {
      setOperationError(null);
      await createOrganizationMutation.mutateAsync({ name });
      setNewOrganizationName("");
    } catch (err) {
      setOperationError(
        err instanceof Error
          ? err.message
          : t("admin.createOrganizationFailed")
      );
    }
  }

  async function saveMapping() {
    if (!orgId || !groupName.trim()) return;
    try {
      setOperationError(null);
      await saveMappingMutation.mutateAsync({
        organizationId: orgId,
        groupName: groupName.trim(),
        role
      });
      setGroupName("");
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : t("admin.saveMappingFailed")
      );
    }
  }

  async function removeMapping(group: string) {
    try {
      setOperationError(null);
      await removeMappingMutation.mutateAsync({
        organizationId: orgId,
        groupName: group
      });
      setRemoveCandidate(null);
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : t("admin.removeMappingFailed")
      );
    }
  }

  return (
    <section className="app-page admin-page" nve-layout="column gap:lg pad:md @md|pad:xl">
      <UiPageHeading
        icon={<ShieldCog size={24} />}
        title={t("admin.title")}
      />

      <div className="admin-content">
        <UiCard className="admin-auth-card" accented>
          <UiSectionHeading
            headingLevel={2}
            icon={<ShieldCheck size={18} />}
            title={t("admin.authSettings")}
            actions={<UiHelpTooltip content={t("admin.authDescription")} />}
          />

          {settings ? (
            <>
              <div className="admin-fields-grid admin-fields-grid-two">
                <div className="admin-managed-field">
                  <UiInput
                    label={t("admin.siteName")}
                    value={settings.site_name || ""}
                    disabled={settings.managed_fields.includes("site_name")}
                    onChange={(event) => setSettings({ ...settings, site_name: event.target.value })}
                    placeholder={t("admin.siteName")}
                  />
                  {settings.managed_fields.includes("site_name") && (
                    <small>{t("admin.managedByDeployment")}</small>
                  )}
                </div>
                <UiInput
                  label={t("admin.loginAnnouncement")}
                  value={settings.announcement || ""}
                  onChange={(event) => setSettings({ ...settings, announcement: event.target.value })}
                  placeholder={t("admin.loginAnnouncementPlaceholder")}
                />
              </div>

              <section className="admin-settings-section">
                <UiSectionHeading
                  className="admin-settings-heading"
                  icon={<KeyRound size={16} />}
                  title={t("admin.signInMethods")}
                />
                <div className="admin-signin-methods">
                  <UiCheckbox
                    label={t("admin.allowLocalLogin")}
                    checked={settings.allow_local_login}
                    onChange={(event) => setSettings({ ...settings, allow_local_login: event.target.checked })}
                  />
                  <UiCheckbox
                    label={t("admin.allowRegistration")}
                    checked={settings.allow_local_registration}
                    onChange={(event) =>
                      setSettings({ ...settings, allow_local_registration: event.target.checked })
                    }
                  />
                  <UiCheckbox
                    label={t("admin.allowOidc")}
                    checked={settings.allow_oidc}
                    onChange={(event) => setSettings({ ...settings, allow_oidc: event.target.checked })}
                  />
                </div>
                <UiSelect
                  label={t("admin.anonymousAccess")}
                  value={settings.anonymous_mode || "off"}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "off" || value === "read_only" || value === "read_write_named") {
                      setSettings({ ...settings, anonymous_mode: value });
                    }
                  }}
                >
                  <option value="off">{t("admin.anonymousOff")}</option>
                  <option value="read_only">{t("admin.anonymousReadOnly")}</option>
                  <option value="read_write_named">{t("admin.anonymousReadWrite")}</option>
                </UiSelect>
              </section>

              <section className="admin-settings-section admin-oidc-section">
                <UiSectionHeading
                  className="admin-settings-heading"
                  icon={<Network size={16} />}
                  title={t("admin.oidcTitle")}
                  actions={<UiHelpTooltip content={t("admin.oidcDescription")} />}
                />
                <div className="admin-fields-grid admin-oidc-grid">
                  <UiInput
                    className="admin-oidc-discovery"
                    label={t("admin.discoveryUrl")}
                    value={discoveryUrl}
                    onChange={(event) => setDiscoveryUrl(event.target.value)}
                    placeholder="https://login.example.com/.well-known/openid-configuration"
                  />
                  <UiInput
                    label={t("admin.clientId")}
                    value={settings.oidc_client_id || ""}
                    onChange={(event) => setSettings({ ...settings, oidc_client_id: event.target.value })}
                    placeholder={t("admin.clientId")}
                  />
                  <UiInput
                    label={t("admin.clientSecret")}
                    type="password"
                    value={settings.oidc_client_secret || ""}
                    onChange={(event) => setSettings({ ...settings, oidc_client_secret: event.target.value })}
                    placeholder={t("admin.clientSecret")}
                  />
                  <UiInput
                    className="admin-oidc-redirect"
                    label={t("admin.redirectUri")}
                    value={settings.oidc_redirect_uri || ""}
                    onChange={(event) => setSettings({ ...settings, oidc_redirect_uri: event.target.value })}
                    placeholder={t("admin.redirectUri")}
                  />
                  <UiInput
                    label={t("admin.groupsClaim")}
                    value={settings.oidc_groups_claim || "groups"}
                    onChange={(event) => setSettings({ ...settings, oidc_groups_claim: event.target.value })}
                    placeholder={t("admin.groupsClaim")}
                  />
                </div>
              </section>

              <div className="admin-card-actions">
                <UiButton variant="primary" onClick={saveAuthSettings} disabled={busyAction !== null}>
                  <span className="admin-button-content">
                    {busyAction === "auth" ? (
                      <LoaderCircle className="admin-spin" size={15} aria-hidden />
                    ) : (
                      <Save size={15} aria-hidden />
                    )}
                    {t("admin.saveAuthSettings")}
                  </span>
                </UiButton>
              </div>
            </>
          ) : (
            <div className="admin-loading">
              <LoaderCircle className="admin-spin" size={18} aria-hidden />
              <span>{t("common.loading")}</span>
            </div>
          )}
        </UiCard>

        <UiCard className="admin-organizations-card">
          <UiSectionHeading
            headingLevel={2}
            icon={<Building2 size={18} />}
            title={t("admin.organizations")}
            actions={
              <>
                <UiBadge
                  tone="neutral"
                  aria-label={t("admin.organizationCount", { count: organizations.length })}
                >
                  {organizations.length}
                </UiBadge>
                <UiHelpTooltip content={t("admin.organizationsDescription")} />
              </>
            }
          />
          <div className="admin-organization-create">
            <UiInput
              label={t("admin.newOrganization")}
              value={newOrganizationName}
              onChange={(event) => setNewOrganizationName(event.target.value)}
              placeholder={t("admin.organizationName")}
            />
            <UiButton
              variant="primary"
              onClick={createOrganizationAction}
              disabled={!newOrganizationName.trim() || busyAction !== null}
            >
              <span className="admin-button-content">
                {busyAction === "organization" ? (
                  <LoaderCircle className="admin-spin" size={15} aria-hidden />
                ) : (
                  <Plus size={15} aria-hidden />
                )}
                {t("common.create")}
              </span>
            </UiButton>
          </div>
          <UiSelect
            label={t("admin.organizationToManage")}
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
            disabled={organizations.length === 0}
          >
            {organizations.length === 0 ? (
              <option value="">{t("admin.noOrganizations")}</option>
            ) : (
              organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))
            )}
          </UiSelect>
        </UiCard>

        <UiCard className="admin-mapping-card">
          <UiSectionHeading
            headingLevel={2}
            icon={<UsersRound size={18} />}
            title={t("admin.groupMapping")}
            actions={
              <>
                <UiBadge tone="neutral" aria-label={t("admin.mappingCount", { count: mappings.length })}>
                  {mappings.length}
                </UiBadge>
                <UiHelpTooltip content={t("admin.groupMappingDescription")} />
              </>
            }
          />

          <div className="admin-mapping-form">
            <UiInput
              label={t("admin.oidcGroup")}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder={t("admin.groupName")}
            />
            <UiSelect
              label={t("admin.organizationRole")}
              value={role}
              onChange={(event) => setRole(event.target.value as OrganizationMembershipRole)}
            >
              {roleOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </UiSelect>
            <UiButton
              variant="primary"
              onClick={saveMapping}
              disabled={!orgId || !groupName.trim() || busyAction !== null}
            >
              <span className="admin-button-content">
                {busyAction === "mapping" ? (
                  <LoaderCircle className="admin-spin" size={15} aria-hidden />
                ) : (
                  <UserRoundPlus size={15} aria-hidden />
                )}
                {t("common.save")}
              </span>
            </UiButton>
          </div>

          <div className="admin-mapping-list">
            {mappings.map((mapping) => (
              <article key={mapping.group_name} className="admin-mapping-item">
                <span className="admin-mapping-icon" aria-hidden>
                  <UsersRound size={16} />
                </span>
                <strong>{mapping.group_name}</strong>
                <UiBadge tone={mapping.role === "owner" ? "accent" : "neutral"}>
                  {roleOptions.find((option) => option.value === mapping.role)?.label ?? mapping.role}
                </UiBadge>
                <UiIconButton
                  tooltip={t("common.remove")}
                  label={t("common.remove")}
                  className="admin-remove-mapping"
                  onClick={() => setRemoveCandidate(mapping.group_name)}
                >
                  <Trash2 size={15} />
                </UiIconButton>
              </article>
            ))}
            {mappings.length === 0 ? (
              <UiEmptyState
                className="admin-mapping-empty"
                icon={<UsersRound size={21} />}
                iconFrame
                description={t("admin.noMappings")}
              />
            ) : null}
          </div>
        </UiCard>

        {error ? (
          <nve-alert status="danger" role="alert">
            <span>{error}</span>
          </nve-alert>
        ) : null}
      </div>

      <UiDialog
        open={!!removeCandidate}
        title={t("admin.removeMappingTitle")}
        description={removeCandidate ? t("admin.removeMappingHint", { group: removeCandidate }) : undefined}
        onClose={() => setRemoveCandidate(null)}
        actions={
          <>
            <UiButton onClick={() => setRemoveCandidate(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant="danger"
              disabled={!removeCandidate || busyAction !== null}
              onClick={() => removeCandidate && removeMapping(removeCandidate)}
            >
              {t("common.remove")}
            </UiButton>
          </>
        }
      />
    </section>
  );
}
