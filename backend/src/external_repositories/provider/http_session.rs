use super::{ExternalGitGateway, ExternalGitProviderError};
use uuid::Uuid;

pub(super) struct AuthenticatedProviderClient<'request, 'runtime> {
    gateway: &'request ExternalGitGateway<'runtime>,
    http_client: &'request reqwest::Client,
    user_id: Uuid,
}

impl<'request, 'runtime> AuthenticatedProviderClient<'request, 'runtime> {
    pub(super) const fn new(
        gateway: &'request ExternalGitGateway<'runtime>,
        http_client: &'request reqwest::Client,
        user_id: Uuid,
    ) -> Self {
        Self {
            gateway,
            http_client,
            user_id,
        }
    }

    pub(super) async fn send(
        &self,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ExternalGitProviderError> {
        let access_token = self.gateway.access_token(self.user_id, false).await?;
        let response = self.send_once(&build, &access_token).await?;
        let response = if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let refreshed = self.gateway.access_token(self.user_id, true).await?;
            let response = self.send_once(&build, &refreshed).await?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                self.gateway
                    .mark_reauthorization_required(self.user_id, "api_rejected_refreshed_token")
                    .await;
            }
            response
        } else {
            response
        };
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(classify_provider_status(response.status()))
        }
    }

    async fn send_once(
        &self,
        build: &impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
        access_token: &str,
    ) -> Result<reqwest::Response, ExternalGitProviderError> {
        build(self.http_client)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|source| ExternalGitProviderError::Transport { source })
    }
}

fn classify_provider_status(status: reqwest::StatusCode) -> ExternalGitProviderError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => ExternalGitProviderError::ReauthorizationRequired,
        reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::LOCKED => {
            ExternalGitProviderError::Forbidden
        }
        reqwest::StatusCode::NOT_FOUND => ExternalGitProviderError::NotFound,
        reqwest::StatusCode::BAD_REQUEST
        | reqwest::StatusCode::PAYLOAD_TOO_LARGE
        | reqwest::StatusCode::UNPROCESSABLE_ENTITY => ExternalGitProviderError::InvalidRequest,
        reqwest::StatusCode::CONFLICT => ExternalGitProviderError::Conflict,
        value if value == reqwest::StatusCode::TOO_MANY_REQUESTS || value.is_server_error() => {
            ExternalGitProviderError::Unavailable { status: value }
        }
        value => ExternalGitProviderError::UnexpectedStatus { status: value },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_status_mapping_preserves_domain_significance() {
        assert!(matches!(
            classify_provider_status(reqwest::StatusCode::UNAUTHORIZED),
            ExternalGitProviderError::ReauthorizationRequired
        ));
        assert!(matches!(
            classify_provider_status(reqwest::StatusCode::CONFLICT),
            ExternalGitProviderError::Conflict
        ));
        assert!(matches!(
            classify_provider_status(reqwest::StatusCode::TOO_MANY_REQUESTS),
            ExternalGitProviderError::Unavailable {
                status: reqwest::StatusCode::TOO_MANY_REQUESTS
            }
        ));
        assert!(matches!(
            classify_provider_status(reqwest::StatusCode::IM_A_TEAPOT),
            ExternalGitProviderError::UnexpectedStatus {
                status: reqwest::StatusCode::IM_A_TEAPOT
            }
        ));
    }
}
