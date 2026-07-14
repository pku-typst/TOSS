//! Request principals, accounts, effective project authorization, and access grants.

mod account_policy;
mod auth_settings;
mod auth_settings_http;
mod auth_settings_model;
mod auth_settings_persistence;
mod authorization;
mod federated_account;
mod federated_account_persistence;
mod grant;
mod grant_http;
mod grant_model;
mod grant_persistence;
mod http_error;
mod identity_persistence;
mod identity_queries;
mod local_account;
mod oidc_claims;
mod oidc_group;
mod oidc_group_http;
mod oidc_group_model;
mod oidc_group_persistence;
mod oidc_http;
mod oidc_persistence;
mod oidc_policy;
mod oidc_protocol;
mod oidc_state;
mod organization;
mod organization_http;
mod organization_model;
mod organization_persistence;
mod personal_token;
mod personal_token_http;
mod personal_token_model;
mod personal_token_persistence;
mod principal;
mod resolution_persistence;
mod session;
mod session_http;
mod session_persistence;
mod sharing;
mod sharing_http;
mod sharing_model;
mod sharing_persistence;
mod template_grant_persistence;
mod template_grants;

pub(crate) use auth_settings::effective_auth_settings;
pub(crate) use auth_settings_http::{
    auth_config, get_admin_auth_settings, upsert_admin_auth_settings, AdminAuthSettingsResponse,
    AuthConfigResponse, UpsertAdminAuthSettingsInput,
};
pub(crate) use auth_settings_model::{AnonymousMode, AuthSettings, OidcProviderDefaults};
pub(crate) use authorization::{
    ensure_project_access, ensure_project_role, ensure_project_role_for_user, ensure_site_admin,
    list_project_catalog_access, lock_project_access_epoch, lock_project_access_mutation,
    project_access_epoch, project_user_has_catalog_access, AccessNeed, ProjectAccessEpochMatch,
    ProjectAuthorizationError, ProjectCatalogAccess,
};
pub(crate) use federated_account::{
    bind_federated_identity, federated_identity_user_id, provision_federated_account,
    remove_federated_identity, BindFederatedIdentityError, LoginAuthorityKind,
    ProvisionFederatedAccountCommand, ProvisionFederatedAccountError,
    RemoveFederatedIdentityOutcome,
};
pub(crate) use grant::grant_initial_project_owner;
pub(crate) use grant_http::{
    delete_group_role, delete_project_organization_access, list_group_roles,
    list_project_access_users, list_project_organization_access, list_roles, upsert_group_role,
    upsert_project_organization_access, upsert_role, ProjectAccessUserListResponse,
    UpsertProjectGroupRoleInput, UpsertProjectOrganizationAccessInput, UpsertRoleInput,
};
#[cfg(test)]
pub(crate) use grant_model::ProjectAccessType;
pub(crate) use grant_model::{
    ProjectAccessUser, ProjectGroupRoleBinding, ProjectOrganizationAccess, ProjectPermission,
    ProjectRole, ProjectRoleBinding,
};
pub(crate) use grant_persistence::grant_project_share_link_role_at_least;
pub(crate) use identity_queries::{
    commit_identity, commit_identity_by_email, list_commit_identities, list_user_identities,
    user_display_name, user_username, CommitIdentity, IdentityLookupError,
};
pub(crate) use local_account::{local_login, local_register, LocalLoginInput, LocalRegisterInput};
pub(crate) use oidc_group_http::{
    delete_org_group_role_mapping, list_org_group_role_mappings, upsert_org_group_role_mapping,
    UpsertOrgGroupRoleMappingInput,
};
pub(crate) use oidc_group_model::OrgGroupRoleMapping;
pub(crate) use oidc_http::{oidc_callback, oidc_login};
pub(crate) use organization::grant_site_admin_membership;
pub(crate) use organization_http::{
    create_organization, list_my_organizations, list_organizations, CreateOrganizationInput,
    OrganizationListResponse, OrganizationMembershipListResponse,
};
pub(crate) use organization_model::{Organization, OrganizationRole};
pub(crate) use organization_persistence::{
    delete_non_owner_organization_membership, list_organization_membership_roles,
    organization_user_is_member, upsert_organization_membership_role,
};
pub(crate) use personal_token::authenticate_personal_access_token;
pub(crate) use personal_token_http::{
    create_personal_access_token, list_personal_access_tokens, revoke_personal_access_token,
    CreatePatInput, CreatePatResponse, PersonalAccessTokenListResponse,
};
pub(crate) use personal_token_model::PersonalAccessTokenInfo;
pub(crate) use principal::{authenticated_user_id, request_user_id, required_request_user_id};
pub(crate) use session_http::{
    auth_cookie_secure, auth_logout, auth_me, issue_session_for_request, session_cookie,
    AuthMeResponse, SessionResponse,
};
pub(crate) use sharing::revoke_project_temporary_sessions;
pub(crate) use sharing_http::{
    create_project_share_link, create_temporary_share_login, join_project_share_link,
    list_project_share_links, resolve_project_share_link, revoke_project_share_link,
    CreateProjectShareLinkInput, CreateProjectShareLinkResponse, JoinProjectShareLinkResponse,
    ResolveProjectShareLinkResponse, TemporaryShareLoginInput, TemporaryShareLoginResponse,
};
pub(crate) use sharing_model::ProjectShareLink;
pub(crate) use template_grants::{
    grant_template_organization_access, list_template_organization_grants,
    revoke_all_template_organization_access, revoke_template_organization_access,
    TemplateOrganizationGrant,
};
