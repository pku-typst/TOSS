//! HTTP representation of Templates capability errors.

use super::builtin_instantiation::InstantiateBuiltinTemplateError;
use super::gallery_listing::ListTemplateGalleryError;
use super::organization_grants::{
    GrantTemplateOrganizationAccessError, RevokeTemplateOrganizationAccessError,
};
use super::publication::UpdateTemplatePublicationError;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::http::StatusCode;

impl From<ListTemplateGalleryError> for ApiError {
    fn from(source: ListTemplateGalleryError) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::TemplateGalleryUnavailable,
            "Template gallery is unavailable",
        )
        .with_diagnostic("template gallery loading failed", source)
    }
}

impl From<UpdateTemplatePublicationError> for ApiError {
    fn from(source: UpdateTemplatePublicationError) -> Self {
        match source {
            UpdateTemplatePublicationError::ProjectNotFound => template_not_found(),
            failure @ UpdateTemplatePublicationError::Persistence(_) => {
                template_service_unavailable(failure)
            }
        }
    }
}

impl From<GrantTemplateOrganizationAccessError> for ApiError {
    fn from(source: GrantTemplateOrganizationAccessError) -> Self {
        match source {
            GrantTemplateOrganizationAccessError::ProjectNotFound => template_not_found(),
            GrantTemplateOrganizationAccessError::ProjectNotPublished => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::TemplatePublicationRequired,
                "Publish the project as a template before sharing it with an organization",
            ),
            GrantTemplateOrganizationAccessError::OrganizationMembershipRequired => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::TemplateOrganizationMembershipRequired,
                "Organization membership is required to share this template",
            ),
            failure @ GrantTemplateOrganizationAccessError::Persistence(_) => {
                template_service_unavailable(failure)
            }
        }
    }
}

impl From<RevokeTemplateOrganizationAccessError> for ApiError {
    fn from(source: RevokeTemplateOrganizationAccessError) -> Self {
        match source {
            RevokeTemplateOrganizationAccessError::GrantNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::TemplateOrganizationGrantNotFound,
                "Template organization access was not found",
            ),
            failure @ RevokeTemplateOrganizationAccessError::Persistence { .. } => {
                template_service_unavailable(failure)
            }
        }
    }
}

impl From<InstantiateBuiltinTemplateError> for ApiError {
    fn from(source: InstantiateBuiltinTemplateError) -> Self {
        match source {
            InstantiateBuiltinTemplateError::AssetTooLarge { .. } => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::TemplateAssetTooLarge,
                "A built-in template asset is too large",
            ),
            failure @ InstantiateBuiltinTemplateError::InvalidTextAsset { .. } => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "Built-in template configuration is invalid",
            )
            .with_diagnostic("built-in template configuration is invalid", failure),
            failure @ (InstantiateBuiltinTemplateError::Identity(_)
            | InstantiateBuiltinTemplateError::AssetStorage { .. }
            | InstantiateBuiltinTemplateError::Persistence(_)) => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::TemplateInstantiationUnavailable,
                "Built-in template instantiation is unavailable",
            )
            .with_diagnostic("built-in template instantiation failed", failure),
        }
    }
}

fn template_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        ApiErrorCode::TemplateNotFound,
        "Template was not found",
    )
}

pub(super) fn template_service_unavailable(
    source: impl std::fmt::Debug + Send + Sync + 'static,
) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::TemplateServiceUnavailable,
        "Template service is unavailable",
    )
    .with_diagnostic("template publication service failed", source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_requirement_has_a_semantic_conflict_response() {
        let error = ApiError::from(GrantTemplateOrganizationAccessError::ProjectNotPublished);

        assert_eq!(error.status(), StatusCode::CONFLICT);
        assert_eq!(error.code(), ApiErrorCode::TemplatePublicationRequired);
    }

    #[test]
    fn missing_organization_grant_has_a_semantic_not_found_response() {
        let error = ApiError::from(RevokeTemplateOrganizationAccessError::GrantNotFound);

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            error.code(),
            ApiErrorCode::TemplateOrganizationGrantNotFound
        );
    }

    #[test]
    fn oversized_builtin_asset_has_a_semantic_payload_response() {
        let error = ApiError::from(InstantiateBuiltinTemplateError::AssetTooLarge {
            path: "large-image.png".to_owned(),
        });

        assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.code(), ApiErrorCode::TemplateAssetTooLarge);
    }
}
