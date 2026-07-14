use utoipa::OpenApi;

mod error;
mod parameters;
pub use error::{ApiErrorCode, ApiErrorResponse};

macro_rules! json_operation {
    ($name:ident, $method:ident, $path:literal, $tag:literal, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            responses(
                (status = $status, description = "Successful response", body = $response),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
    ($name:ident, $method:ident, $path:literal, $tag:literal, $request:ty, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            request_body = $request,
            responses(
                (status = $status, description = "Successful response", body = $response),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
}

macro_rules! json_array_operation {
    ($name:ident, $method:ident, $path:literal, $tag:literal, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            responses(
                (status = $status, description = "Successful response", body = [$response]),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
    ($name:ident, $method:ident, $path:literal, $tag:literal, $request:ty, $status:literal, $response:ty) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            request_body = $request,
            responses(
                (status = $status, description = "Successful response", body = [$response]),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
}

macro_rules! empty_operation {
    ($name:ident, $method:ident, $path:literal, $tag:literal, $status:literal) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            responses(
                (status = $status, description = "Successful response"),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
    ($name:ident, $method:ident, $path:literal, $tag:literal, $request:ty, $status:literal) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            request_body = $request,
            responses(
                (status = $status, description = "Successful response"),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
}

macro_rules! binary_operation {
    ($name:ident, $method:ident, $path:literal, $tag:literal, $content_type:literal) => {
        #[utoipa::path(
            $method,
            path = $path,
            tag = $tag,
            responses(
                (status = 200, description = "Binary response", body = [u8], content_type = $content_type),
                (status = "default", description = "Error response", body = ApiErrorResponse)
            )
        )]
        #[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
        pub(super) fn $name() {}
    };
}

mod access;
mod collaboration;
mod experience;
mod external_repositories;
mod runtime;
mod templates;
mod versioning;
mod workspace;
pub use external_repositories::ExternalGitCheckpointResponse;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "TOSS API",
        version = "1.0.0",
        description = "Versioned browser-to-server protocol for the TOSS modular monolith."
    ),
    paths(
        runtime::health,
        experience::experience,
        experience::help,
        experience::product_favicon,
        experience::product_touch_icon,
        access::auth_config,
        access::local_login,
        access::local_register,
        access::oidc_login,
        access::oidc_callback,
        access::gitlab_login,
        access::gitlab_callback,
        access::auth_me,
        access::auth_logout,
        external_repositories::external_git_status,
        external_repositories::disconnect_external_git,
        external_repositories::authorize_external_git,
        external_repositories::external_git_oauth_callback,
        external_repositories::external_git_login,
        external_repositories::external_git_repository_owners,
        external_repositories::external_git_repositories,
        external_repositories::external_git_repository_branches,
        external_repositories::external_git_import,
        external_repositories::external_git_job,
        collaboration::realtime_auth,
        collaboration::realtime_websocket,
        collaboration::project_realtime_websocket,
        access::list_personal_access_tokens,
        access::create_personal_access_token,
        access::revoke_personal_access_token,
        access::list_organizations,
        access::create_organization,
        access::list_my_organizations,
        templates::list_template_gallery,
        templates::builtin_template_thumbnail,
        templates::create_from_builtin_template,
        workspace::list_projects,
        workspace::create_project,
        workspace::rename_project,
        external_repositories::external_git_project_status,
        external_repositories::request_external_git_checkpoint,
        external_repositories::linked_external_git_branches,
        external_repositories::request_external_git_sync,
        external_repositories::create_external_git_repository,
        external_repositories::link_external_git_repository,
        external_repositories::unlink_external_git_repository,
        workspace::copy_project,
        templates::update_project_template,
        templates::list_template_organization_access,
        templates::upsert_template_organization_access,
        templates::delete_template_organization_access,
        workspace::project_thumbnail,
        workspace::upload_project_thumbnail,
        workspace::project_tree,
        workspace::create_project_file,
        workspace::move_project_file,
        workspace::delete_project_file,
        access::list_project_roles,
        access::upsert_project_role,
        access::list_project_access_users,
        workspace::project_settings,
        workspace::update_project_entry_file,
        workspace::update_project_latex_engine,
        access::list_project_organization_access,
        access::upsert_project_organization_access,
        access::delete_project_organization_access,
        access::list_project_share_links,
        access::create_project_share_link,
        access::revoke_project_share_link,
        access::list_project_group_roles,
        access::upsert_project_group_role,
        access::delete_project_group_role,
        versioning::list_revisions,
        versioning::create_revision,
        versioning::revision_documents,
        workspace::list_documents,
        workspace::create_document,
        workspace::upsert_document_by_path,
        workspace::get_document,
        workspace::update_document,
        workspace::delete_document,
        workspace::list_project_assets,
        workspace::upload_project_asset,
        workspace::get_project_asset,
        workspace::delete_project_asset,
        workspace::get_project_asset_raw,
        workspace::download_project_archive,
        workspace::update_project_archived,
        workspace::upload_pdf_artifact,
        workspace::download_latest_pdf_artifact,
        runtime::typst_package,
        runtime::typst_builtin,
        runtime::latex_texlive,
        versioning::git_status,
        versioning::git_repo_link,
        versioning::git_smart_http_info_refs,
        versioning::git_smart_http_rpc,
        access::resolve_project_share,
        access::temporary_share_login,
        access::join_project_share,
        access::list_org_group_role_mappings,
        access::upsert_org_group_role_mapping,
        access::delete_org_group_role_mapping,
        access::get_admin_auth_settings,
        access::upsert_admin_auth_settings
    ),
    components(schemas(
        ApiErrorCode,
        ApiErrorResponse,
        crate::protocol::RealtimeClientMessage,
        crate::protocol::RealtimeCursorPayload,
        crate::protocol::RealtimeMetadataPayload,
        crate::protocol::RealtimeServerEvent,
        crate::protocol::RealtimeWorkspaceChangeScope,
        crate::protocol::RealtimeWorkspaceChangedPayload
    )),
    tags(
        (name = "identity-access"),
        (name = "workspace"),
        (name = "collaboration"),
        (name = "versioning"),
        (name = "external-repositories"),
        (name = "templates"),
        (name = "experience"),
        (name = "runtime")
    )
)]
struct ApiDocument;

pub fn openapi_document() -> utoipa::openapi::OpenApi {
    let mut document = ApiDocument::openapi();
    parameters::add_to(&mut document);
    document
}

#[cfg(test)]
mod tests;
