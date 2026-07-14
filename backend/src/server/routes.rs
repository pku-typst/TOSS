use super::runtime::health;
use crate::access::{
    auth_config, auth_logout, auth_me, create_organization, create_personal_access_token,
    create_project_share_link, create_temporary_share_login, delete_group_role,
    delete_org_group_role_mapping, delete_project_organization_access, get_admin_auth_settings,
    join_project_share_link, list_group_roles, list_my_organizations, list_org_group_role_mappings,
    list_organizations, list_personal_access_tokens, list_project_access_users,
    list_project_organization_access, list_project_share_links, list_roles, local_login,
    local_register, oidc_callback, oidc_login, resolve_project_share_link,
    revoke_personal_access_token, revoke_project_share_link, upsert_admin_auth_settings,
    upsert_group_role, upsert_org_group_role_mapping, upsert_project_organization_access,
    upsert_role,
};
use crate::app_state::AppState;
use crate::collaboration::{project_ws_handler, realtime_auth, ws_handler};
use crate::experience::{
    experience_config, help_content, product_favicon, product_touch_icon, spa_index,
};
use crate::external_repositories::{
    authorize_external_git, create_external_git_import, create_external_git_repository,
    disconnect_external_git, external_git_connection_status, external_git_login,
    external_git_oauth_callback, external_git_project_status, get_external_git_inbound_job,
    link_external_git_repository, list_external_git_repositories,
    list_external_git_repository_branches, list_external_git_repository_owners,
    list_linked_external_git_repository_branches, request_external_git_checkpoint,
    request_external_git_inbound_sync, unlink_external_git_repository,
};
use crate::latex_runtime::latex_texlive_proxy;
use crate::templates::{
    create_project_from_builtin_template, delete_project_template_organization_access,
    get_builtin_template_thumbnail, list_project_template_organization_access,
    list_template_gallery, update_project_template, upsert_project_template_organization_access,
};
use crate::typst_runtime::{typst_builtin_asset, typst_package_proxy};
use crate::versioning::{
    create_revision, get_revision_documents, git_http_backend, git_repo_link, git_status,
    list_revisions,
};
use crate::workspace::{
    copy_project, create_document, create_project, create_project_file, delete_document,
    delete_project_asset, delete_project_file, download_latest_project_pdf_artifact,
    download_project_archive, get_document, get_project_asset, get_project_asset_raw,
    get_project_settings, get_project_thumbnail, get_project_tree, list_documents,
    list_project_assets, list_projects, move_project_file, update_document,
    update_project_archived, update_project_entry_file, update_project_latex_engine,
    update_project_name, upload_project_asset, upload_project_pdf_artifact,
    upload_project_thumbnail, upsert_document_by_path,
};
use axum::middleware;
use axum::routing::{any, delete, get, patch, post, put};
use axum::Router;

pub(super) fn build_router() -> Router<AppState> {
    Router::new()
        .route("/", get(spa_index))
        .route("/index.html", get(spa_index))
        .route("/health", get(health))
        .route("/favicon.ico", get(product_favicon))
        .route("/v1/experience", get(experience_config))
        .route("/v1/help", get(help_content))
        .route("/v1/product-assets/favicon", get(product_favicon))
        .route("/v1/product-assets/touch-icon", get(product_touch_icon))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/local/login", post(local_login))
        .route("/v1/auth/local/register", post(local_register))
        .route("/v1/auth/oidc/login", get(oidc_login))
        .route("/v1/auth/oidc/callback", get(oidc_callback))
        .route("/v1/auth/gitlab/login", get(oidc_login))
        .route("/v1/auth/gitlab/callback", get(oidc_callback))
        .route(
            "/v1/auth/external-git/{provider_id}/login",
            get(external_git_login),
        )
        .route("/v1/auth/me", get(auth_me))
        .route("/v1/auth/logout", post(auth_logout))
        .route(
            "/v1/external-git/providers/{provider_id}/connection",
            get(external_git_connection_status).delete(disconnect_external_git),
        )
        .route(
            "/v1/external-git/providers/{provider_id}/authorize",
            get(authorize_external_git),
        )
        .route(
            "/v1/external-git/providers/{provider_id}/callback",
            get(external_git_oauth_callback),
        )
        .route(
            "/v1/external-git/providers/{provider_id}/owners",
            get(list_external_git_repository_owners),
        )
        .route(
            "/v1/external-git/providers/{provider_id}/repositories",
            get(list_external_git_repositories),
        )
        .route(
            "/v1/external-git/providers/{provider_id}/repositories/{repository_id}/branches",
            get(list_external_git_repository_branches),
        )
        .route("/v1/external-git/imports", post(create_external_git_import))
        .route(
            "/v1/external-git/jobs/{job_id}",
            get(get_external_git_inbound_job),
        )
        .route("/v1/realtime/auth/{project_id}", get(realtime_auth))
        .route(
            "/v1/realtime/projects/{project_id}",
            get(project_ws_handler),
        )
        .route("/v1/realtime/ws/{doc_id}", get(ws_handler))
        .route(
            "/v1/profile/security/tokens",
            get(list_personal_access_tokens).post(create_personal_access_token),
        )
        .route(
            "/v1/profile/security/tokens/{token_id}",
            delete(revoke_personal_access_token),
        )
        .route(
            "/v1/organizations",
            get(list_organizations).post(create_organization),
        )
        .route("/v1/organizations/mine", get(list_my_organizations))
        .route("/v1/templates", get(list_template_gallery))
        .route(
            "/v1/templates/builtin/{template_id}/thumbnail",
            get(get_builtin_template_thumbnail),
        )
        .route(
            "/v1/templates/builtin/{template_id}/projects",
            post(create_project_from_builtin_template),
        )
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}", patch(update_project_name))
        .route(
            "/v1/projects/{project_id}/external-git/status",
            get(external_git_project_status),
        )
        .route(
            "/v1/projects/{project_id}/external-git/checkpoint",
            post(request_external_git_checkpoint),
        )
        .route(
            "/v1/projects/{project_id}/external-git/branches",
            get(list_linked_external_git_repository_branches),
        )
        .route(
            "/v1/projects/{project_id}/external-git/sync",
            post(request_external_git_inbound_sync),
        )
        .route(
            "/v1/projects/{project_id}/external-git/create",
            post(create_external_git_repository),
        )
        .route(
            "/v1/projects/{project_id}/external-git/link",
            post(link_external_git_repository),
        )
        .route(
            "/v1/projects/{project_id}/external-git/unlink",
            post(unlink_external_git_repository),
        )
        .route("/v1/projects/{project_id}/copy", post(copy_project))
        .route(
            "/v1/projects/{project_id}/template",
            put(update_project_template),
        )
        .route(
            "/v1/projects/{project_id}/template-organization-access",
            get(list_project_template_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/template-organization-access/{org_id}",
            put(upsert_project_template_organization_access)
                .delete(delete_project_template_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/thumbnail",
            get(get_project_thumbnail).put(upload_project_thumbnail),
        )
        .route("/v1/projects/{project_id}/tree", get(get_project_tree))
        .route("/v1/projects/{project_id}/files", post(create_project_file))
        .route(
            "/v1/projects/{project_id}/files/move",
            patch(move_project_file),
        )
        .route(
            "/v1/projects/{project_id}/files/{*path}",
            delete(delete_project_file),
        )
        .route(
            "/v1/projects/{project_id}/roles",
            get(list_roles).post(upsert_role),
        )
        .route(
            "/v1/projects/{project_id}/access-users",
            get(list_project_access_users),
        )
        .route(
            "/v1/projects/{project_id}/settings",
            get(get_project_settings),
        )
        .route(
            "/v1/projects/{project_id}/settings/entry-file",
            patch(update_project_entry_file),
        )
        .route(
            "/v1/projects/{project_id}/settings/latex-engine",
            patch(update_project_latex_engine),
        )
        .route(
            "/v1/projects/{project_id}/organization-access",
            get(list_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/organization-access/{org_id}",
            put(upsert_project_organization_access).delete(delete_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/share-links",
            get(list_project_share_links).post(create_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/share-links/{share_link_id}",
            delete(revoke_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/group-roles",
            get(list_group_roles).post(upsert_group_role),
        )
        .route(
            "/v1/projects/{project_id}/group-roles/{group_name}",
            delete(delete_group_role),
        )
        .route(
            "/v1/projects/{project_id}/revisions",
            get(list_revisions).post(create_revision),
        )
        .route(
            "/v1/projects/{project_id}/revisions/{revision_id}/documents",
            get(get_revision_documents),
        )
        .route(
            "/v1/projects/{project_id}/documents",
            get(list_documents).post(create_document),
        )
        .route(
            "/v1/projects/{project_id}/documents/by-path/{path}",
            put(upsert_document_by_path),
        )
        .route(
            "/v1/projects/{project_id}/documents/{document_id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route(
            "/v1/projects/{project_id}/assets",
            get(list_project_assets).post(upload_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}",
            get(get_project_asset).delete(delete_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}/raw",
            get(get_project_asset_raw),
        )
        .route(
            "/v1/projects/{project_id}/archive",
            get(download_project_archive).patch(update_project_archived),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts",
            post(upload_project_pdf_artifact),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts/latest",
            get(download_latest_project_pdf_artifact),
        )
        .route(
            "/v1/typst/packages/{namespace}/{name}/{version}",
            get(typst_package_proxy),
        )
        .route("/v1/typst/builtin/{*path}", get(typst_builtin_asset))
        .route("/v1/latex/texlive/{*path}", get(latex_texlive_proxy))
        .route("/v1/git/status/{project_id}", get(git_status))
        .route("/v1/git/repo-link/{project_id}", get(git_repo_link))
        .route("/v1/git/repo/{project_id}/{*rest}", any(git_http_backend))
        .route("/v1/share/{token}/resolve", get(resolve_project_share_link))
        .route(
            "/v1/share/{token}/temporary-login",
            post(create_temporary_share_login),
        )
        .route("/v1/share/{token}/join", post(join_project_share_link))
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings",
            get(list_org_group_role_mappings).post(upsert_org_group_role_mapping),
        )
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings/{group_name}",
            delete(delete_org_group_role_mapping),
        )
        .route(
            "/v1/admin/settings/auth",
            get(get_admin_auth_settings).put(upsert_admin_auth_settings),
        )
        .layer(middleware::from_fn(
            crate::http_response::normalize_api_error_response,
        ))
}
