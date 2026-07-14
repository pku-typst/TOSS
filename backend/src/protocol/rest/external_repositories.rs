use super::ApiErrorResponse;
use crate::external_repositories::{
    CreateExternalGitImportInput, CreateExternalGitRepositoryInput, ExternalGitBranchListResponse,
    ExternalGitProjectLinkMutationResponse, ExternalGitRepositoryListResponse,
    ExternalGitRepositoryOwnerListResponse, ExternalRepositoryConnectionStatus,
    ExternalRepositoryInboundJob, ExternalRepositoryProjectStatus, LinkExternalGitRepositoryInput,
    RequestExternalGitInboundSyncInput,
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct ExternalGitCheckpointResponse {
    pub accepted: bool,
    pub up_to_date: bool,
    pub target_workspace_version: i64,
}

json_operation!(
    external_git_status,
    get,
    "/v1/external-git/providers/{provider_id}/connection",
    "external-repositories",
    200,
    ExternalRepositoryConnectionStatus
);
empty_operation!(
    disconnect_external_git,
    delete,
    "/v1/external-git/providers/{provider_id}/connection",
    "external-repositories",
    204
);

#[utoipa::path(
    get,
    path = "/v1/external-git/providers/{provider_id}/authorize",
    tag = "external-repositories",
    params(
        ("provider_id" = String, Path, description = "Configured provider instance ID"),
        ("return_to" = Option<String>, Query, description = "Same-origin path restored after authorization")
    ),
    responses(
        (status = 303, description = "Redirect to the configured provider authorization flow"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn authorize_external_git() {}

#[utoipa::path(
    get,
    path = "/v1/external-git/providers/{provider_id}/callback",
    tag = "external-repositories",
    params(
        ("provider_id" = String, Path, description = "Configured provider instance ID"),
        ("code" = Option<String>, Query, description = "Provider authorization code"),
        ("state" = Option<String>, Query, description = "One-time OAuth attempt state"),
        ("error" = Option<String>, Query, description = "Provider error when authorization was declined")
    ),
    responses(
        (status = 303, description = "Login or repository authorization completed and browser returned to the application"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn external_git_oauth_callback() {}

#[utoipa::path(
    get,
    path = "/v1/auth/external-git/{provider_id}/login",
    tag = "access",
    params(
        ("provider_id" = String, Path, description = "Configured provider instance ID"),
        ("return_to" = Option<String>, Query, description = "Same-origin path restored after login")
    ),
    responses(
        (status = 303, description = "Redirect to provider login"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn external_git_login() {}

json_operation!(
    external_git_repository_owners,
    get,
    "/v1/external-git/providers/{provider_id}/owners",
    "external-repositories",
    200,
    ExternalGitRepositoryOwnerListResponse
);
json_operation!(
    external_git_repositories,
    get,
    "/v1/external-git/providers/{provider_id}/repositories",
    "external-repositories",
    200,
    ExternalGitRepositoryListResponse
);
json_operation!(
    external_git_repository_branches,
    get,
    "/v1/external-git/providers/{provider_id}/repositories/{repository_id}/branches",
    "external-repositories",
    200,
    ExternalGitBranchListResponse
);
json_operation!(
    external_git_import,
    post,
    "/v1/external-git/imports",
    "external-repositories",
    CreateExternalGitImportInput,
    202,
    ExternalRepositoryInboundJob
);
json_operation!(
    external_git_job,
    get,
    "/v1/external-git/jobs/{job_id}",
    "external-repositories",
    200,
    ExternalRepositoryInboundJob
);
json_operation!(
    external_git_project_status,
    get,
    "/v1/projects/{project_id}/external-git/status",
    "external-repositories",
    200,
    ExternalRepositoryProjectStatus
);

#[utoipa::path(
    post,
    path = "/v1/projects/{project_id}/external-git/checkpoint",
    tag = "external-repositories",
    responses(
        (status = 200, description = "Project is already synchronized", body = ExternalGitCheckpointResponse),
        (status = 202, description = "Checkpoint was queued", body = ExternalGitCheckpointResponse),
        (status = 204, description = "Project has no external repository link"),
        (status = "default", description = "Error response", body = ApiErrorResponse)
    )
)]
#[allow(dead_code, reason = "contract marker consumed by the OpenAPI derive")]
pub(super) fn request_external_git_checkpoint() {}

json_operation!(
    linked_external_git_branches,
    get,
    "/v1/projects/{project_id}/external-git/branches",
    "external-repositories",
    200,
    ExternalGitBranchListResponse
);
json_operation!(
    request_external_git_sync,
    post,
    "/v1/projects/{project_id}/external-git/sync",
    "external-repositories",
    RequestExternalGitInboundSyncInput,
    202,
    ExternalRepositoryInboundJob
);
json_operation!(
    create_external_git_repository,
    post,
    "/v1/projects/{project_id}/external-git/create",
    "external-repositories",
    CreateExternalGitRepositoryInput,
    201,
    ExternalGitProjectLinkMutationResponse
);
json_operation!(
    link_external_git_repository,
    post,
    "/v1/projects/{project_id}/external-git/link",
    "external-repositories",
    LinkExternalGitRepositoryInput,
    200,
    ExternalGitProjectLinkMutationResponse
);
empty_operation!(
    unlink_external_git_repository,
    post,
    "/v1/projects/{project_id}/external-git/unlink",
    "external-repositories",
    204
);
