//! Process-wide runtime composition passed to HTTP handlers and background workers.

use crate::access::OidcProviderDefaults;
use crate::collaboration::CollaborationContext;
use crate::distribution::{AiAssistantConfig, DistributionConfig, FrontendFeature};
use crate::document_processing::DocumentProcessingContext;
use crate::external_repositories::{
    ExternalGitGateway, ExternalGitProviderRegistry, ProviderInstanceId,
};
use crate::object_storage::ObjectStorage;
use crate::versioning::VersioningContext;
use sqlx::PgPool;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct AppState {
    pub db: PgPool,
    pub oidc_defaults: OidcProviderDefaults,
    pub external_git_providers: ExternalGitProviderRegistry,
    pub data_dir: PathBuf,
    pub typst_builtin_dir: PathBuf,
    pub storage: Option<ObjectStorage>,
    pub distribution: Arc<DistributionConfig>,
    pub frontend_features: Arc<Vec<FrontendFeature>>,
    pub ai_assistant: Arc<Option<AiAssistantConfig>>,
    pub spa_index_html: Arc<[u8]>,
    pub collaboration: CollaborationContext,
    pub versioning: VersioningContext,
    pub processing: DocumentProcessingContext,
}

impl AppState {
    pub(crate) fn external_git_gateway(
        &self,
        provider_id: &ProviderInstanceId,
    ) -> ExternalGitGateway<'_> {
        ExternalGitGateway::new(&self.db, self.external_git_providers.get(provider_id))
    }
}
