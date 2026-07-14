use super::connection::ProviderAccessTokenError;
use super::provider::ExternalGitProviderError;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::http::StatusCode;

#[derive(Clone, Copy)]
enum ProviderDiagnostic {
    None,
    Warning(&'static str),
    Error(&'static str),
}

pub(super) fn external_git_provider_error(error: ExternalGitProviderError) -> ApiError {
    let diagnostic = match &error {
        ExternalGitProviderError::Transport { .. }
        | ExternalGitProviderError::Unavailable { .. }
        | ExternalGitProviderError::UnexpectedStatus { .. }
        | ExternalGitProviderError::InvalidResponse { .. }
        | ExternalGitProviderError::MalformedResponse => {
            ProviderDiagnostic::Warning("external Git provider request failed")
        }
        ExternalGitProviderError::Credential { source } => match source {
            ProviderAccessTokenError::Persistence { .. }
            | ProviderAccessTokenError::Cipher { .. } => {
                ProviderDiagnostic::Error("external Git credential access failed")
            }
            ProviderAccessTokenError::RefreshUnavailable { .. }
            | ProviderAccessTokenError::InvalidRefreshResponse { .. }
            | ProviderAccessTokenError::ConcurrentRefreshUnavailable => {
                ProviderDiagnostic::Warning("external Git credential refresh failed")
            }
            ProviderAccessTokenError::NotConfigured
            | ProviderAccessTokenError::NotConnected
            | ProviderAccessTokenError::ReauthorizationRequired => ProviderDiagnostic::None,
        },
        _ => ProviderDiagnostic::None,
    };
    let response = match &error {
        ExternalGitProviderError::NotConfigured => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ExternalGitNotConfigured,
            "External Git is not configured",
        ),
        ExternalGitProviderError::ReauthorizationRequired => ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            ApiErrorCode::ExternalGitAuthorizationRequired,
            "External Git authorization expired; authorize the provider again",
        ),
        ExternalGitProviderError::Forbidden => ApiError::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::ExternalGitRepositoryForbidden,
            "The external Git provider denied this operation",
        ),
        ExternalGitProviderError::NotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ExternalGitRepositoryNotFound,
            "The external Git repository was not found",
        ),
        ExternalGitProviderError::InvalidRequest => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ApiErrorCode::UnprocessableEntity,
            "Repository settings are invalid or were rejected by the external Git provider",
        ),
        ExternalGitProviderError::Conflict => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ExternalGitRepositoryConflict,
            "The external Git repository is already linked or the requested path is unavailable",
        ),
        ExternalGitProviderError::Transport { .. }
        | ExternalGitProviderError::Unavailable { .. } => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::ExternalGitProviderUnavailable,
            "The external Git provider is temporarily unavailable",
        ),
        ExternalGitProviderError::UnexpectedStatus { .. }
        | ExternalGitProviderError::InvalidResponse { .. }
        | ExternalGitProviderError::MalformedResponse => ApiError::new(
            StatusCode::BAD_GATEWAY,
            ApiErrorCode::ExternalGitProviderUnavailable,
            "The external Git provider returned an invalid response",
        ),
        ExternalGitProviderError::Credential { source } => match source {
            ProviderAccessTokenError::NotConfigured => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::ExternalGitNotConfigured,
                "External Git is not configured",
            ),
            ProviderAccessTokenError::NotConnected => ApiError::new(
                StatusCode::PRECONDITION_REQUIRED,
                ApiErrorCode::ExternalGitAuthorizationRequired,
                "Authorize the external Git provider before using this feature",
            ),
            ProviderAccessTokenError::ReauthorizationRequired => ApiError::new(
                StatusCode::PRECONDITION_REQUIRED,
                ApiErrorCode::ExternalGitAuthorizationRequired,
                "External Git authorization expired; authorize the provider again",
            ),
            ProviderAccessTokenError::RefreshUnavailable { .. }
            | ProviderAccessTokenError::ConcurrentRefreshUnavailable => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::ExternalGitProviderUnavailable,
                "The external Git provider is temporarily unavailable",
            ),
            ProviderAccessTokenError::InvalidRefreshResponse { .. } => ApiError::new(
                StatusCode::BAD_GATEWAY,
                ApiErrorCode::ExternalGitProviderUnavailable,
                "The external Git provider returned an invalid response",
            ),
            ProviderAccessTokenError::Persistence { .. }
            | ProviderAccessTokenError::Cipher { .. } => ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "External Git integration failed",
            ),
        },
    };
    match diagnostic {
        ProviderDiagnostic::None => response,
        ProviderDiagnostic::Warning(context) => response.with_warning(context, error),
        ProviderDiagnostic::Error(context) => response.with_diagnostic(context, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_failures_preserve_client_actions() {
        let not_configured = external_git_provider_error(ExternalGitProviderError::NotConfigured);
        assert_eq!(not_configured.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            not_configured.code(),
            ApiErrorCode::ExternalGitNotConfigured
        );

        let reauthorize =
            external_git_provider_error(ExternalGitProviderError::ReauthorizationRequired);
        assert_eq!(reauthorize.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(
            reauthorize.code(),
            ApiErrorCode::ExternalGitAuthorizationRequired
        );

        let missing = external_git_provider_error(ExternalGitProviderError::NotFound);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.code(), ApiErrorCode::ExternalGitRepositoryNotFound);
    }
}
