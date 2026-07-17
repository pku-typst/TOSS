//! External Repositories worker composition and its narrow runtime dependencies.

use super::provider::{ExternalGitGateway, ExternalGitProviderRegistry, ProviderInstanceId};
use crate::collaboration::CollaborationContext;
use crate::distribution::DistributionConfig;
use crate::object_storage::ObjectStorage;
use crate::process_lifecycle::DrainSignal;
use crate::versioning::VersioningContext;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub(in crate::external_repositories) struct ExternalGitWorkerRuntime {
    pub(in crate::external_repositories) db: PgPool,
    providers: ExternalGitProviderRegistry,
    pub(in crate::external_repositories) storage: Option<ObjectStorage>,
    pub(in crate::external_repositories) distribution: Arc<DistributionConfig>,
    pub(in crate::external_repositories) collaboration: CollaborationContext,
    pub(in crate::external_repositories) versioning: VersioningContext,
    pub(in crate::external_repositories) drain: DrainSignal,
}

impl ExternalGitWorkerRuntime {
    fn new(
        db: PgPool,
        providers: ExternalGitProviderRegistry,
        storage: Option<ObjectStorage>,
        distribution: Arc<DistributionConfig>,
        collaboration: CollaborationContext,
        versioning: VersioningContext,
        drain: DrainSignal,
    ) -> Self {
        Self {
            db,
            providers,
            storage,
            distribution,
            collaboration,
            versioning,
            drain,
        }
    }

    pub(in crate::external_repositories) fn provider_ids(&self) -> Vec<ProviderInstanceId> {
        self.providers.instance_ids().collect()
    }

    pub(in crate::external_repositories) fn gateway(
        &self,
        provider_id: &ProviderInstanceId,
    ) -> ExternalGitGateway<'_> {
        ExternalGitGateway::new(
            &self.db,
            self.providers.get(provider_id),
            self.drain.clone(),
        )
    }
}

pub(crate) fn spawn_external_git_workers(
    db: PgPool,
    providers: ExternalGitProviderRegistry,
    storage: Option<ObjectStorage>,
    distribution: Arc<DistributionConfig>,
    collaboration: CollaborationContext,
    versioning: VersioningContext,
    drain: DrainSignal,
) -> Vec<tokio::task::JoinHandle<()>> {
    let runtime = ExternalGitWorkerRuntime::new(
        db,
        providers,
        storage,
        distribution,
        collaboration,
        versioning,
        drain,
    );
    let mut workers = super::checkpoint::spawn_external_git_checkpoint_worker(runtime.clone());
    workers.extend(super::inbound::spawn_external_git_inbound_worker(runtime));
    workers
}
