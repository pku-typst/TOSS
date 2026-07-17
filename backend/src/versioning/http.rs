mod merge;
mod protocol;
mod receive_pack;
mod transport;

use self::protocol::{git_http_user, parse_cgi_http_backend_prefix, CGI_RESPONSE_PREFIX_BYTES};
use self::receive_pack::ReceivePackSession;
use self::transport::{execute_git_http_backend, GitBackendExecutionError};
use super::local_repository::{checkout_branch, ensure_initialized, storage_root};
use crate::access::{ensure_project_role, ensure_project_role_for_user, AccessNeed};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Json;
use std::env;
use std::time::Duration;
use tokio::process::Command;
use tracing::error;
use uuid::Uuid;

use super::state::GitSyncState;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct GitRepoLink {
    pub project_id: Uuid,
    pub repo_url: String,
}

fn git_http_backend_timeout_seconds() -> u64 {
    env::var("GIT_HTTP_BACKEND_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 5)
        .unwrap_or(120)
}

async fn recover_failed_backend(
    session: Option<&ReceivePackSession<'_>>,
    project_id: Uuid,
    failure_context: &'static str,
) {
    let Some(session) = session else {
        return;
    };
    if let Err(recovery_error) = session.recover_backend_failure().await {
        error!(%recovery_error, %project_id, failure_context, "Git backend recovery failed");
    }
}

pub(crate) async fn git_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitSyncState>, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    match crate::versioning::find_sync_state(&state.db, project_id).await {
        Ok(Some(sync_state)) => Ok(Json(sync_state)),
        Ok(None) => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ProjectNotFound,
            "Project Git state not found",
        )),
        Err(database_error) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::RevisionServiceUnavailable,
            "Project Git state is unavailable",
        )
        .with_diagnostic("Git sync state lookup failed", database_error)),
    }
}

pub(crate) async fn git_repo_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRepoLink>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let host = headers
        .get(header::HOST)
        .and_then(|header| header.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = if headers
        .get("x-forwarded-proto")
        .and_then(|header| header.to_str().ok())
        .unwrap_or("http")
        == "https"
    {
        "https"
    } else {
        "http"
    };
    let username_hint = crate::versioning::git_username_hint(&state.db, actor).await;
    Ok(Json(GitRepoLink {
        project_id,
        repo_url: format!("{scheme}://{username_hint}@{host}/v1/git/repo/{project_id}"),
    }))
}

pub(crate) async fn git_http_backend(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((project_id, rest)): Path<(Uuid, String)>,
    body: Bytes,
) -> impl IntoResponse {
    let query = uri.query().unwrap_or_default();
    let advertises_receive_pack =
        rest.ends_with("info/refs") && query.contains("service=git-receive-pack");
    let advertises_upload_pack =
        rest.ends_with("info/refs") && query.contains("service=git-upload-pack");
    let actor = match git_http_user(&state.db, &headers).await {
        Ok(Some(user_id)) => user_id,
        Ok(None) => {
            let mut response = (StatusCode::UNAUTHORIZED, "Git auth required").into_response();
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static("Basic realm=\"Typst Git\""),
            );
            return response;
        }
        Err(authentication_error) => {
            error!(error = ?authentication_error, "Git personal access token authentication failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Git authentication failed",
            )
                .into_response();
        }
    };
    let can_push = rest.ends_with("git-receive-pack");
    let is_push_flow = can_push || advertises_receive_pack;
    let is_pull_flow = rest.ends_with("git-upload-pack") || advertises_upload_pack;
    let access_need = if is_push_flow {
        AccessNeed::GitSync
    } else {
        AccessNeed::Read
    };
    if let Err(authorization_error) =
        ensure_project_role_for_user(&state.db, actor, project_id, access_need).await
    {
        if authorization_error.is_permission_denied() {
            return (StatusCode::FORBIDDEN, "Forbidden").into_response();
        }
        error!(error = ?authorization_error, %project_id, %actor, "Git authorization failed");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Authorization service unavailable",
        )
            .into_response();
    }
    let _git_lock = state.versioning.acquire_project_lock(project_id).await;

    let config = match crate::versioning::load_repository(&state.db, project_id).await {
        Ok(Some(config)) => config,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "Git repository config missing").into_response();
        }
        Err(database_error) => {
            error!(%database_error, %project_id, "Git repository config lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load Git repository config",
            )
                .into_response();
        }
    };
    if ensure_initialized(&config.local_path, &config.default_branch).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to initialize repo",
        )
            .into_response();
    }
    if checkout_branch(&config.local_path, &config.default_branch).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to checkout project branch",
        )
            .into_response();
    }
    let push_session = if can_push {
        match ReceivePackSession::capture(&state, project_id, actor, &config).await {
            Ok(session) => Some(session),
            Err(snapshot_error) => {
                error!(%snapshot_error, %project_id, "receive-pack safety snapshot failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to prepare a safe Git push",
                )
                    .into_response();
            }
        }
    } else {
        None
    };
    if is_pull_flow && config.pending_sync {
        if let Err(flush_error) = crate::versioning::flush_pending_server_commit(
            &state.db,
            state.storage.as_ref(),
            &state.distribution,
            project_id,
            Some(actor),
            None,
            None,
        )
        .await
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to prepare pending online updates: {flush_error}"),
            )
                .into_response();
        }
    }

    let command = build_git_http_command(
        &headers,
        &method,
        query,
        project_id,
        &rest,
        actor,
        body.len(),
    );
    let mut output = match execute_git_http_backend(
        command,
        body,
        Duration::from_secs(git_http_backend_timeout_seconds()),
        state.drain.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(GitBackendExecutionError::Io(process_error)) => {
            error!(%process_error, %project_id, "git http-backend execution failed");
            recover_failed_backend(push_session.as_ref(), project_id, "execution failure").await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend failed").into_response();
        }
        Err(GitBackendExecutionError::TimedOut) => {
            error!(%project_id, "git http-backend timed out");
            recover_failed_backend(push_session.as_ref(), project_id, "timeout").await;
            return (StatusCode::GATEWAY_TIMEOUT, "Git backend timed out").into_response();
        }
        Err(GitBackendExecutionError::Interrupted) => {
            recover_failed_backend(push_session.as_ref(), project_id, "process drain").await;
            return crate::process_lifecycle::unavailable_response();
        }
    };
    if !output.status.success() && output.stdout_is_empty() {
        error!(status = ?output.status, stderr = %output.stderr, %project_id, "git http-backend exited with failure");
        recover_failed_backend(push_session.as_ref(), project_id, "failed exit").await;
        return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend failed").into_response();
    }

    let response_prefix = match output.read_stdout_prefix(CGI_RESPONSE_PREFIX_BYTES).await {
        Ok(prefix) => prefix,
        Err(read_error) => {
            error!(%read_error, %project_id, "git http-backend response could not be read");
            recover_failed_backend(push_session.as_ref(), project_id, "response read").await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend failed").into_response();
        }
    };
    let response_head = match parse_cgi_http_backend_prefix(&response_prefix, output.stdout_len()) {
        Ok(response_head) => response_head,
        Err(parse_error) => {
            error!(%parse_error, %project_id, "git http-backend returned an invalid response");
            recover_failed_backend(push_session.as_ref(), project_id, "response parse").await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend failed").into_response();
        }
    };
    let status = response_head.status;
    let response_headers = response_head.headers;
    let response_body = match output.into_body(response_head.body_offset).await {
        Ok(body) => body,
        Err(stream_error) => {
            error!(%stream_error, %project_id, "git http-backend response stream could not start");
            recover_failed_backend(push_session.as_ref(), project_id, "response stream").await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Git backend failed").into_response();
        }
    };

    if let Some(session) = push_session.as_ref() {
        match session.finalize(status).await {
            Ok(Some(rejection_response)) => return rejection_response,
            Ok(None) => {}
            Err(recovery_error) => {
                error!(%recovery_error, %project_id, "receive-pack rejection recovery failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Git push could not be recovered safely",
                )
                    .into_response();
            }
        }
    }

    let mut builder = axum::http::Response::builder().status(status);
    for (key, value) in response_headers {
        builder = builder.header(key, value);
    }
    builder
        .body(response_body)
        .unwrap_or_else(|_| axum::http::Response::new(Body::from("backend response error")))
}

fn build_git_http_command(
    headers: &HeaderMap,
    method: &Method,
    query: &str,
    project_id: Uuid,
    rest: &str,
    actor: Uuid,
    body_len: usize,
) -> Command {
    let path_info = if rest.is_empty() {
        format!("/{project_id}/.git")
    } else {
        format!("/{project_id}/.git/{rest}")
    };
    let mut command = Command::new("git");
    command.arg("http-backend");
    command.env(
        "GIT_PROJECT_ROOT",
        storage_root().to_string_lossy().to_string(),
    );
    command.env("GIT_HTTP_EXPORT_ALL", "1");
    command.env("REQUEST_METHOD", method.as_str());
    command.env("PATH_INFO", path_info);
    command.env("QUERY_STRING", query);
    command.env(
        "CONTENT_TYPE",
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|header| header.to_str().ok())
            .unwrap_or(""),
    );
    command.env("CONTENT_LENGTH", body_len.to_string());
    command.env("REMOTE_USER", actor.to_string());
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    command
}
