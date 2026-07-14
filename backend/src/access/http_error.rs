//! HTTP representation of Access-owned authentication and authorization errors.

use super::authorization::{ProjectAuthorizationError, SiteAdminAuthorizationError};
use super::principal::RequestAuthenticationError;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::http::StatusCode;
use axum::response::IntoResponse;

impl From<RequestAuthenticationError> for ApiError {
    fn from(source: RequestAuthenticationError) -> Self {
        match source {
            RequestAuthenticationError::Required => authentication_required(),
            failure @ RequestAuthenticationError::Store(_) => {
                authorization_unavailable("request principal resolution failed", failure)
            }
        }
    }
}

impl From<ProjectAuthorizationError> for ApiError {
    fn from(source: ProjectAuthorizationError) -> Self {
        match source {
            ProjectAuthorizationError::AuthenticationRequired => authentication_required(),
            ProjectAuthorizationError::Authentication(RequestAuthenticationError::Required) => {
                authentication_required()
            }
            ProjectAuthorizationError::PermissionDenied => ApiError::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::ProjectAccessForbidden,
                "Project access is forbidden",
            ),
            failure @ (ProjectAuthorizationError::Authentication(
                RequestAuthenticationError::Store(_),
            )
            | ProjectAuthorizationError::Store(_)) => {
                authorization_unavailable("project authorization failed", failure)
            }
        }
    }
}

impl IntoResponse for ProjectAuthorizationError {
    fn into_response(self) -> axum::response::Response {
        ApiError::from(self).into_response()
    }
}

impl From<SiteAdminAuthorizationError> for ApiError {
    fn from(source: SiteAdminAuthorizationError) -> Self {
        match source {
            SiteAdminAuthorizationError::AuthenticationRequired => authentication_required(),
            SiteAdminAuthorizationError::Authentication(RequestAuthenticationError::Required) => {
                authentication_required()
            }
            SiteAdminAuthorizationError::PermissionDenied => ApiError::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::SiteAdminRequired,
                "Site administrator access is required",
            ),
            failure @ (SiteAdminAuthorizationError::Authentication(
                RequestAuthenticationError::Store(_),
            )
            | SiteAdminAuthorizationError::Store(_)) => {
                authorization_unavailable("site administrator authorization failed", failure)
            }
        }
    }
}

impl IntoResponse for SiteAdminAuthorizationError {
    fn into_response(self) -> axum::response::Response {
        ApiError::from(self).into_response()
    }
}

fn authentication_required() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        ApiErrorCode::AuthRequired,
        "Authentication required",
    )
}

fn authorization_unavailable(
    context: &'static str,
    source: impl std::fmt::Debug + Send + Sync + 'static,
) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::AuthorizationUnavailable,
        "Authorization service is unavailable",
    )
    .with_diagnostic(context, source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_and_project_denial_have_distinct_protocol_codes() {
        let authentication = ApiError::from(RequestAuthenticationError::Required);
        assert_eq!(authentication.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(authentication.code(), ApiErrorCode::AuthRequired);

        let project = ApiError::from(ProjectAuthorizationError::PermissionDenied);
        assert_eq!(project.status(), StatusCode::FORBIDDEN);
        assert_eq!(project.code(), ApiErrorCode::ProjectAccessForbidden);
    }

    #[test]
    fn site_administrator_denial_has_an_actionable_protocol_code() {
        let error = ApiError::from(SiteAdminAuthorizationError::PermissionDenied);
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(error.code(), ApiErrorCode::SiteAdminRequired);
    }
}
