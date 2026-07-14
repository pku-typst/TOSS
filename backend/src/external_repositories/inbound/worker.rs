use super::content::{
    apply_external_git_inbound_content, AppliedExternalGitInboundState,
    ApplyExternalGitInboundCommand, ApplyExternalGitInboundError,
};
use super::import::{
    prepare_external_git_import, ExternalGitImportFailure, ImportedExternalGitAsset,
    PreparedExternalGitImport,
};
use super::job_lifecycle::{
    complete_job, record_failure, CompleteInboundJobError, InboundFailure,
    InboundFailurePersistence,
};
use super::persistence::{self, AppliedInboundJob, ClaimedInboundJob, InboundJobLink};
use super::ExternalGitInboundPhase;
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::collaboration::CollaborationContext;
use crate::distribution::DistributionConfig;
use crate::external_repositories::{
    external_git_command_timeout_seconds, ExternalGitCommandFailure, ExternalGitFailureCode,
    ExternalGitGateway,
};
use crate::object_cleanup::{
    cleanup_uncommitted_object, cleanup_uncommitted_objects, delete_queued_objects_now,
};
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use crate::versioning::{FlushPendingServerCommitError, VersioningContext};
use crate::workspace::{
    load_project_entry_point, LoadProjectEntryPointError, ProjectEntryPoint, WorkspaceAsset,
    WorkspaceDocument,
};
use chrono::Utc;
use sqlx::PgPool;
use std::env;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;
use tracing::error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum InboundPersistenceStage {
    LoadLink,
    RecordLfsPhase,
    RecordValidationPhase,
    RecordAssetsPhase,
    RecordApplyPhase,
}

#[derive(Debug, Error)]
enum InboundJobError {
    #[error("external repository link is missing for inbound job {job_id}")]
    LinkMissing { job_id: Uuid },
    #[error("inbound job {job_id} could not load project {project_id} entry point")]
    ProjectEntryPoint {
        job_id: Uuid,
        project_id: Uuid,
        #[source]
        source: LoadProjectEntryPointError,
    },
    #[error("inbound job {job_id} persistence failed during {stage:?}")]
    Persistence {
        stage: InboundPersistenceStage,
        job_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("inbound job {job_id} could not create a checkout directory")]
    Checkout {
        job_id: Uuid,
        #[source]
        source: std::io::Error,
    },
    #[error("inbound job {job_id} provider command failed")]
    Provider {
        job_id: Uuid,
        #[source]
        source: ExternalGitCommandFailure,
    },
    #[error("inbound job {job_id} returned an invalid remote revision")]
    InvalidRemoteRevision { job_id: Uuid },
    #[error("inbound job {job_id} repository content was rejected")]
    Import {
        job_id: Uuid,
        #[source]
        source: ExternalGitImportFailure,
    },
    #[error("inbound job {job_id} could not read repository content at {path:?}")]
    ContentRead {
        job_id: Uuid,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("inbound job {job_id} could not stage object {object_key}")]
    AssetStorage {
        job_id: Uuid,
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error("inbound job {job_id} could not apply repository content")]
    Apply {
        job_id: Uuid,
        #[source]
        source: ApplyExternalGitInboundError,
    },
    #[error("inbound job {job_id} could not create its imported revision")]
    Revision {
        job_id: Uuid,
        #[source]
        source: FlushPendingServerCommitError,
    },
    #[error("inbound job {job_id} could not complete")]
    Completion {
        job_id: Uuid,
        #[source]
        source: CompleteInboundJobError,
    },
}

impl InboundJobError {
    fn failure(&self) -> InboundFailure {
        match self {
            Self::Provider { source, .. } => {
                InboundFailure::from_command(source.kind(), source.code())
            }
            Self::LinkMissing { .. } => {
                InboundFailure::terminal(ExternalGitFailureCode::ExternalGitLinkMissing)
            }
            Self::ProjectEntryPoint { source, .. } => match source {
                LoadProjectEntryPointError::ProjectNotFound => {
                    InboundFailure::terminal(ExternalGitFailureCode::ProjectNotFound)
                }
                LoadProjectEntryPointError::Persistence { .. } => {
                    InboundFailure::retryable(ExternalGitFailureCode::RepositoryImportStateFailed)
                }
            },
            Self::Checkout { .. } => {
                InboundFailure::retryable(ExternalGitFailureCode::GitFetchFailed)
            }
            Self::InvalidRemoteRevision { .. } => {
                InboundFailure::retryable(ExternalGitFailureCode::RepositoryRevisionInvalid)
            }
            Self::Import { source, .. } => InboundFailure::terminal(source.code()),
            Self::ContentRead { .. } => {
                InboundFailure::terminal(ExternalGitFailureCode::RepositoryContentUnreadable)
            }
            Self::AssetStorage { .. } => {
                InboundFailure::retryable(ExternalGitFailureCode::RepositoryAssetStoreFailed)
            }
            Self::Apply { source, .. } => match source {
                ApplyExternalGitInboundError::ProjectNotFound { .. } => {
                    InboundFailure::terminal(ExternalGitFailureCode::ProjectNotFound)
                }
                ApplyExternalGitInboundError::InvalidEntryFile { .. } => {
                    InboundFailure::terminal(ExternalGitFailureCode::RepositoryMissingEntryFile)
                }
                ApplyExternalGitInboundError::CommitAmbiguous { .. } => {
                    InboundFailure::ambiguous_apply()
                }
                ApplyExternalGitInboundError::WorkspaceChanged { .. }
                | ApplyExternalGitInboundError::WorkspaceFlush { .. }
                | ApplyExternalGitInboundError::Persistence { .. } => {
                    InboundFailure::retryable(ExternalGitFailureCode::RepositoryApplyFailed)
                }
            },
            Self::Revision { .. } => InboundFailure::retryable_from_revision(
                ExternalGitFailureCode::RepositoryRevisionFailed,
            ),
            Self::Completion { .. } => InboundFailure::retryable_from_revision(
                ExternalGitFailureCode::RepositoryImportStateFailed,
            ),
            Self::Persistence { .. } => {
                InboundFailure::retryable(ExternalGitFailureCode::RepositoryImportStateFailed)
            }
        }
    }

    fn staged_assets_may_be_referenced(&self) -> bool {
        matches!(
            self,
            Self::Apply {
                source: ApplyExternalGitInboundError::CommitAmbiguous { .. },
                ..
            }
        )
    }
}

struct StagedAsset {
    id: Uuid,
    path: String,
    object_key: String,
    content_type: String,
    size_bytes: i64,
    inline_source_path: Option<PathBuf>,
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn inbound_worker_interval_seconds() -> u64 {
    env::var("EXTERNAL_GIT_INBOUND_WORKER_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(2)
}

fn inbound_worker_batch_size() -> usize {
    env_usize("EXTERNAL_GIT_INBOUND_WORKER_BATCH_SIZE", 4)
}

async fn prepare_inbound_state(
    db: &PgPool,
    gateway: &ExternalGitGateway<'_>,
    link: &InboundJobLink,
    entry_point: &ProjectEntryPoint,
) -> Result<PreparedExternalGitImport, InboundJobError> {
    let checkout = tempfile::tempdir().map_err(|source| InboundJobError::Checkout {
        job_id: link.id,
        source,
    })?;
    let checkout_root = checkout.path().to_string_lossy().to_string();
    let repository_path = checkout.path().join("repository");
    let repository_path_text = repository_path.to_string_lossy().to_string();
    let clone_args = vec![
        "clone".to_string(),
        "--no-tags".to_string(),
        "--single-branch".to_string(),
        "--branch".to_string(),
        link.source_branch.clone(),
        "--filter=blob:none".to_string(),
        "--".to_string(),
        link.clone_url.clone(),
        repository_path_text.clone(),
    ];
    gateway
        .run_command(
            link.linked_by_user_id,
            &checkout_root,
            &clone_args,
            external_git_command_timeout_seconds(),
        )
        .await
        .map_err(|source| InboundJobError::Provider {
            job_id: link.id,
            source,
        })?;
    persistence::update_job_phase(db, link.id, ExternalGitInboundPhase::Lfs, Utc::now())
        .await
        .map_err(|source| InboundJobError::Persistence {
            stage: InboundPersistenceStage::RecordLfsPhase,
            job_id: link.id,
            source,
        })?;
    gateway
        .run_command(
            link.linked_by_user_id,
            &repository_path_text,
            &["lfs".to_string(), "pull".to_string()],
            external_git_command_timeout_seconds(),
        )
        .await
        .map_err(|source| InboundJobError::Provider {
            job_id: link.id,
            source,
        })?;
    let remote_sha = gateway
        .run_command(
            link.linked_by_user_id,
            &repository_path_text,
            &["rev-parse".to_string(), "HEAD".to_string()],
            30,
        )
        .await
        .map_err(|source| InboundJobError::Provider {
            job_id: link.id,
            source,
        })?
        .trim()
        .to_ascii_lowercase();
    if !matches!(remote_sha.len(), 40 | 64)
        || !remote_sha.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(InboundJobError::InvalidRemoteRevision { job_id: link.id });
    }
    persistence::update_job_phase(db, link.id, ExternalGitInboundPhase::Validate, Utc::now())
        .await
        .map_err(|source| InboundJobError::Persistence {
            stage: InboundPersistenceStage::RecordValidationPhase,
            job_id: link.id,
            source,
        })?;
    prepare_external_git_import(
        checkout,
        repository_path,
        entry_point.project_type,
        &entry_point.entry_file_path,
        remote_sha,
    )
    .map_err(|source| InboundJobError::Import {
        job_id: link.id,
        source,
    })
}

async fn stage_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    job_id: Uuid,
    project_id: Uuid,
    assets: Vec<ImportedExternalGitAsset>,
) -> Result<Vec<StagedAsset>, InboundJobError> {
    let mut staged = Vec::with_capacity(assets.len());
    for asset in assets {
        let id = Uuid::new_v4();
        let (object_key, inline_source_path) = if let Some(storage) = storage {
            let bytes = match std::fs::read(&asset.source_path) {
                Ok(value) => value,
                Err(source) => {
                    cleanup_staged_assets(db, Some(storage), &staged).await;
                    return Err(InboundJobError::ContentRead {
                        job_id,
                        path: asset.source_path,
                        source,
                    });
                }
            };
            let object_key = format!("projects/{project_id}/assets/{id}");
            if let Err(source) = put_object(storage, &object_key, &asset.content_type, bytes).await
            {
                cleanup_uncommitted_object(db, Some(storage), &object_key).await;
                cleanup_staged_assets(db, Some(storage), &staged).await;
                return Err(InboundJobError::AssetStorage {
                    job_id,
                    object_key,
                    source,
                });
            }
            (object_key, None)
        } else {
            (format!("inline://{id}"), Some(asset.source_path.clone()))
        };
        staged.push(StagedAsset {
            id,
            path: asset.path,
            object_key,
            content_type: asset.content_type,
            size_bytes: asset.size_bytes,
            inline_source_path,
        });
        if let Err(source) =
            persistence::update_job_phase(db, job_id, ExternalGitInboundPhase::Assets, Utc::now())
                .await
        {
            cleanup_staged_assets(db, storage, &staged).await;
            return Err(InboundJobError::Persistence {
                stage: InboundPersistenceStage::RecordAssetsPhase,
                job_id,
                source,
            });
        }
    }
    Ok(staged)
}

async fn cleanup_staged_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    assets: &[StagedAsset],
) {
    let object_keys = assets
        .iter()
        .map(|asset| asset.object_key.clone())
        .collect::<Vec<_>>();
    cleanup_uncommitted_objects(db, storage, &object_keys).await;
}

async fn apply_inbound_state(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    collaboration: &CollaborationContext,
    link: &InboundJobLink,
    prepared: &PreparedExternalGitImport,
    staged_assets: &[StagedAsset],
) -> Result<AppliedExternalGitInboundState, InboundJobError> {
    let mut documents = Vec::with_capacity(prepared.documents.len());
    for document in &prepared.documents {
        let content = std::fs::read_to_string(&document.source_path).map_err(|source| {
            InboundJobError::ContentRead {
                job_id: link.id,
                path: document.source_path.clone(),
                source,
            }
        })?;
        documents.push(WorkspaceDocument {
            path: document.path.clone(),
            content,
        });
    }
    let mut assets = Vec::with_capacity(staged_assets.len());
    for asset in staged_assets {
        let inline_data = match &asset.inline_source_path {
            Some(path) => {
                Some(
                    std::fs::read(path).map_err(|source| InboundJobError::ContentRead {
                        job_id: link.id,
                        path: path.clone(),
                        source,
                    })?,
                )
            }
            None => None,
        };
        assets.push(WorkspaceAsset {
            id: asset.id,
            path: asset.path.clone(),
            object_key: asset.object_key.clone(),
            content_type: asset.content_type.clone(),
            size_bytes: asset.size_bytes,
            inline_data,
        });
    }
    apply_external_git_inbound_content(
        db,
        storage,
        distribution,
        collaboration,
        ApplyExternalGitInboundCommand {
            job_id: link.id,
            project_id: link.project_id,
            actor_user_id: link.requested_by_user_id,
            operation: link.operation,
            source_branch: link.source_branch.clone(),
            remote_sha: prepared.remote_sha.clone(),
            entry_file_path: prepared.entry_file_path.clone(),
            documents,
            directories: prepared.directories.clone(),
            assets,
        },
    )
    .await
    .map_err(|source| InboundJobError::Apply {
        job_id: link.id,
        source,
    })
}

async fn finalize_inbound_job(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    link: &InboundJobLink,
    applied: &AppliedInboundJob,
) -> Result<(), InboundJobError> {
    let revision_summary = format!("Import external Git branch {}", link.source_branch);
    crate::versioning::flush_pending_server_commit(
        db,
        storage,
        distribution,
        link.project_id,
        Some(link.requested_by_user_id),
        Some(applied.workspace_version),
        Some(&revision_summary),
    )
    .await
    .map_err(|source| InboundJobError::Revision {
        job_id: link.id,
        source,
    })?;
    complete_job(db, link.id, link.project_id)
        .await
        .map_err(|source| InboundJobError::Completion {
            job_id: link.id,
            source,
        })?;
    record_event(
        db,
        Some(link.requested_by_user_id),
        "external_git.inbound_sync.complete",
        serde_json::json!({
            "job_id": link.id,
            "project_id": link.project_id,
            "operation": link.operation,
            "repository": link.full_path,
            "branch": link.source_branch,
            "remote_sha": applied.remote_sha,
            "workspace_version": applied.workspace_version,
        }),
    )
    .await;
    Ok(())
}

async fn process_inbound_job(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    distribution: &DistributionConfig,
    collaboration: &CollaborationContext,
    versioning: &VersioningContext,
    gateway: &ExternalGitGateway<'_>,
    claimed: &ClaimedInboundJob,
) -> Result<String, InboundJobError> {
    let link = persistence::inbound_job_link(db, claimed.id)
        .await
        .map_err(|source| InboundJobError::Persistence {
            stage: InboundPersistenceStage::LoadLink,
            job_id: claimed.id,
            source,
        })?
        .ok_or(InboundJobError::LinkMissing { job_id: claimed.id })?;
    if let Some(applied) = claimed.applied_state() {
        let _git_lock = versioning.acquire_project_lock(link.project_id).await;
        finalize_inbound_job(db, storage, distribution, &link, &applied).await?;
        return Ok(applied.remote_sha);
    }
    let entry_point = load_project_entry_point(db, link.project_id)
        .await
        .map_err(|source| InboundJobError::ProjectEntryPoint {
            job_id: claimed.id,
            project_id: link.project_id,
            source,
        })?;
    let mut prepared = prepare_inbound_state(db, gateway, &link, &entry_point).await?;
    persistence::update_job_phase(db, link.id, ExternalGitInboundPhase::Assets, Utc::now())
        .await
        .map_err(|source| InboundJobError::Persistence {
            stage: InboundPersistenceStage::RecordAssetsPhase,
            job_id: link.id,
            source,
        })?;
    let staged_assets = stage_assets(
        db,
        storage,
        link.id,
        link.project_id,
        std::mem::take(&mut prepared.assets),
    )
    .await?;
    persistence::update_job_phase(db, link.id, ExternalGitInboundPhase::Apply, Utc::now())
        .await
        .map_err(|source| InboundJobError::Persistence {
            stage: InboundPersistenceStage::RecordApplyPhase,
            job_id: link.id,
            source,
        })?;
    let _git_lock = versioning.acquire_project_lock(link.project_id).await;
    let applied = match apply_inbound_state(
        db,
        storage,
        distribution,
        collaboration,
        &link,
        &prepared,
        &staged_assets,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            if !error.staged_assets_may_be_referenced() {
                cleanup_staged_assets(db, storage, &staged_assets).await;
            }
            return Err(error);
        }
    };
    delete_queued_objects_now(db, storage, &applied.old_object_keys).await;
    collaboration
        .invalidate_project(link.project_id, applied.content_epoch)
        .await;
    let applied = AppliedInboundJob {
        remote_sha: prepared.remote_sha.clone(),
        workspace_version: applied.workspace_version,
    };
    finalize_inbound_job(db, storage, distribution, &link, &applied).await?;
    Ok(applied.remote_sha)
}

async fn record_inbound_failure(
    db: &PgPool,
    claimed: &ClaimedInboundJob,
    failure: &InboundFailure,
) {
    match record_failure(db, claimed, failure).await {
        Ok(InboundFailurePersistence::Recorded) => {}
        Ok(InboundFailurePersistence::ProcessingLeasePreserved) => {
            error!(
                job_id = %claimed.id,
                "external Git inbound commit result is ambiguous; preserving the processing lease for recovery"
            );
        }
        Err(error) => {
            tracing::error!(?error, job_id = %claimed.id, "external Git inbound failure persistence failed");
        }
    }
}

pub(crate) fn spawn_external_git_inbound_worker(state: AppState) {
    let interval = Duration::from_secs(inbound_worker_interval_seconds());
    let batch_size = inbound_worker_batch_size();
    let providers = state
        .external_git_providers
        .instance_ids()
        .collect::<Vec<_>>();
    for provider in providers {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                for _ in 0..batch_size {
                    let now = Utc::now();
                    let claimed = match persistence::claim_due_job(
                        &state.db,
                        &provider,
                        now,
                        now - chrono::Duration::minutes(15),
                    )
                    .await
                    {
                        Ok(Some(value)) => value,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::error!(
                                ?error,
                                "external Git inbound worker could not claim work"
                            );
                            break;
                        }
                    };
                    let gateway = state.external_git_gateway(&provider);
                    match process_inbound_job(
                        &state.db,
                        state.storage.as_ref(),
                        &state.distribution,
                        &state.collaboration,
                        &state.versioning,
                        &gateway,
                        &claimed,
                    )
                    .await
                    {
                        Ok(_) => {}
                        Err(job_error) => {
                            let failure = job_error.failure();
                            error!(
                                error = ?job_error,
                                job_id = %claimed.id,
                                failure_code = %failure.code(),
                                "external Git inbound job failed"
                            );
                            record_inbound_failure(&state.db, &claimed, &failure).await;
                        }
                    }
                }
                tokio::time::sleep(interval).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::job_lifecycle::InboundFailurePolicy;
    use super::*;

    #[test]
    fn post_apply_failure_resumes_at_revision_without_reimporting() {
        let job_id = Uuid::new_v4();
        let failure = InboundJobError::Completion {
            job_id,
            source: CompleteInboundJobError::NotProcessing { job_id },
        }
        .failure();

        assert_eq!(
            failure.policy(),
            InboundFailurePolicy::Retry {
                phase: ExternalGitInboundPhase::Revision,
            }
        );
    }

    #[test]
    fn ambiguous_apply_preserves_assets_and_database_recovery_state() {
        let job_id = Uuid::new_v4();
        let error = InboundJobError::Apply {
            job_id,
            source: ApplyExternalGitInboundError::CommitAmbiguous {
                project_id: Uuid::new_v4(),
                source: sqlx::Error::RowNotFound,
            },
        };
        let failure = error.failure();

        assert!(error.staged_assets_may_be_referenced());
        assert_eq!(
            failure.policy(),
            InboundFailurePolicy::PreserveProcessingLease
        );
    }

    #[test]
    fn rejected_apply_cleans_unreferenced_staged_assets() {
        let job_id = Uuid::new_v4();
        let error = InboundJobError::Apply {
            job_id,
            source: ApplyExternalGitInboundError::ProjectNotFound {
                project_id: Uuid::new_v4(),
            },
        };
        let failure = error.failure();

        assert!(!error.staged_assets_may_be_referenced());
        assert_eq!(
            failure.policy(),
            InboundFailurePolicy::Fail {
                phase: ExternalGitInboundPhase::Queued,
            }
        );
        assert_eq!(failure.code(), ExternalGitFailureCode::ProjectNotFound);
    }
}
