//! Receive-pack reconciliation and compensation as one recoverable session.

use super::super::local_repository::{
    head_oid, is_ancestor, restore_head, worktree_is_clean, RestoreRepositoryHeadError,
};
use super::super::revision_state::{load_git_state_from_commit, LoadGitRevisionStateError};
use super::merge::{
    git_receive_pack_reject_body, git_revision_state_to_merge_map, materialize_merge_map_to_dir,
    merge_online_over_pushed, push_reject_hint_lines, workspace_snapshot_to_merge_map,
    MergeFileValue, MergeWorkspaceResult,
};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::versioning::{
    sync_project_documents_to_repo, sync_repo_documents_to_project, FlushPendingServerCommitError,
    GitRepositoryConfig, MaterializeWorkspaceError, RepositoryImportError,
};
use crate::workspace::LoadProjectContentAssetError;
use axum::body::Body;
use axum::http::{header, Response, StatusCode};
use git2::Repository;
use std::collections::HashMap;
use thiserror::Error;
use tracing::error;
use uuid::Uuid;

const MISSING_ENTRY_FILE_PUSH_MESSAGE: &str =
    "repository must contain a supported project entry file";

struct PushReject {
    reason: String,
    diagnostic: Option<String>,
    workspace_may_have_changed: bool,
}

impl PushReject {
    fn before_workspace_change(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            diagnostic: None,
            workspace_may_have_changed: false,
        }
    }

    fn internal_before_workspace_change(diagnostic: impl Into<String>) -> Self {
        Self {
            reason: "server could not apply pushed content".to_string(),
            diagnostic: Some(diagnostic.into()),
            workspace_may_have_changed: false,
        }
    }

    fn internal_after_workspace_change(diagnostic: impl Into<String>) -> Self {
        Self {
            reason: "server could not apply pushed content".to_string(),
            diagnostic: Some(diagnostic.into()),
            workspace_may_have_changed: true,
        }
    }
}

struct PushWorkspaceSnapshot {
    workspace_version: i64,
    files: HashMap<String, MergeFileValue>,
}

#[derive(Debug, Error)]
pub(super) enum ReceivePackCaptureError {
    #[error("receive-pack head could not be read for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("receive-pack workspace snapshot could not be loaded for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("project {project_id} was not found while preparing receive-pack")]
    ProjectNotFound { project_id: Uuid },
    #[error("receive-pack workspace assets could not be loaded for project {project_id}")]
    Asset {
        project_id: Uuid,
        #[source]
        source: LoadProjectContentAssetError,
    },
}

#[derive(Clone, Copy, Debug)]
pub(super) enum ReceivePackRecoveryPersistenceStage {
    LoadWorkspaceSnapshot,
    LoadRepository,
    RecordSync,
}

#[derive(Debug, Error)]
pub(super) enum ReceivePackRecoveryError {
    #[error("receive-pack recovery Git operation failed for project {project_id}")]
    Git {
        project_id: Uuid,
        #[source]
        source: git2::Error,
    },
    #[error("receive-pack recovery could not restore Git head for project {project_id}")]
    RestoreHead {
        project_id: Uuid,
        #[source]
        source: RestoreRepositoryHeadError,
    },
    #[error("receive-pack recovery persistence failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: ReceivePackRecoveryPersistenceStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("project {project_id} disappeared during receive-pack recovery")]
    ProjectNotFound { project_id: Uuid },
    #[error(
        "Git repository state disappeared during receive-pack recovery for project {project_id}"
    )]
    RepositoryNotFound { project_id: Uuid },
    #[error("receive-pack recovery filesystem operation failed for project {project_id}")]
    Filesystem {
        project_id: Uuid,
        #[source]
        source: std::io::Error,
    },
    #[error("receive-pack recovery could not restore workspace content for project {project_id}")]
    RepositoryImport {
        project_id: Uuid,
        #[source]
        source: RepositoryImportError,
    },
    #[error("receive-pack recovery could not flush workspace changes for project {project_id}")]
    Flush {
        project_id: Uuid,
        #[source]
        source: FlushPendingServerCommitError,
    },
    #[error(
        "receive-pack recovery could not materialize workspace content for project {project_id}"
    )]
    WorkspaceMaterialization {
        project_id: Uuid,
        #[source]
        source: MaterializeWorkspaceError,
    },
}

#[derive(Debug, Error)]
enum MergeOnlineError {
    #[error("online and pushed changes conflict")]
    Conflict(Vec<String>),
    #[error("receive-pack is missing the {head} Git head")]
    MissingHead { head: &'static str },
    #[error("receive-pack merge Git operation failed")]
    Git {
        #[source]
        source: git2::Error,
    },
    #[error("receive-pack merge could not load Git revision state")]
    RevisionState {
        #[source]
        source: LoadGitRevisionStateError,
    },
}

pub(super) struct ReceivePackSession<'a> {
    state: &'a AppState,
    project_id: Uuid,
    actor: Uuid,
    config: &'a GitRepositoryConfig,
    head_before: Option<git2::Oid>,
    workspace_before: PushWorkspaceSnapshot,
}

impl<'a> ReceivePackSession<'a> {
    pub async fn capture(
        state: &'a AppState,
        project_id: Uuid,
        actor: Uuid,
        config: &'a GitRepositoryConfig,
    ) -> Result<Self, ReceivePackCaptureError> {
        let head_before = head_oid(&config.local_path)
            .map_err(|source| ReceivePackCaptureError::Git { project_id, source })?;
        let snapshot = crate::workspace::load_project_content_snapshot(&state.db, project_id)
            .await
            .map_err(|source| ReceivePackCaptureError::Persistence { project_id, source })?
            .ok_or(ReceivePackCaptureError::ProjectNotFound { project_id })?;
        let files = workspace_snapshot_to_merge_map(state, &snapshot)
            .await
            .map_err(|source| ReceivePackCaptureError::Asset { project_id, source })?;
        Ok(Self {
            state,
            project_id,
            actor,
            config,
            head_before,
            workspace_before: PushWorkspaceSnapshot {
                workspace_version: snapshot.workspace_version,
                files,
            },
        })
    }

    pub async fn recover_backend_failure(&self) -> Result<(), ReceivePackRecoveryError> {
        let head_after =
            head_oid(&self.config.local_path).map_err(|source| ReceivePackRecoveryError::Git {
                project_id: self.project_id,
                source,
            })?;
        if head_after == self.head_before {
            return Ok(());
        }
        self.restore_rejected_push(false).await
    }

    pub async fn finalize(
        &self,
        backend_status: StatusCode,
    ) -> Result<Option<Response<Body>>, ReceivePackRecoveryError> {
        let rejection = match self.reconcile(backend_status).await {
            Ok(()) => return Ok(None),
            Err(rejection) => rejection,
        };
        if let Some(diagnostic) = rejection.diagnostic.as_deref() {
            error!(
                %diagnostic,
                project_id = %self.project_id,
                "receive-pack rejected after server-side processing failure"
            );
        }
        self.restore_rejected_push(rejection.workspace_may_have_changed)
            .await?;
        Ok(Some(self.rejection_response(&rejection.reason)))
    }

    async fn reconcile(&self, backend_status: StatusCode) -> Result<(), PushReject> {
        let head_after = head_oid(&self.config.local_path).map_err(|head_error| {
            PushReject::internal_before_workspace_change(format!(
                "failed to inspect receive-pack head: {head_error}"
            ))
        })?;
        if head_after == self.head_before {
            return Ok(());
        }
        if !backend_status.is_success() {
            return Err(PushReject::before_workspace_change(
                "Git backend rejected the updated branch",
            ));
        }
        validate_default_ref_update(&self.config.local_path, self.head_before, head_after)
            .map_err(|rejection| PushReject::before_workspace_change(rejection.message()))?;

        if self.config.pending_sync {
            self.merge_online_delta(head_after).await
        } else {
            self.import_pushed_workspace().await
        }
    }

    async fn merge_online_delta(&self, head_after: Option<git2::Oid>) -> Result<(), PushReject> {
        let merged_map = self
            .build_merged_workspace(head_after)
            .await
            .map_err(|merge_error| match merge_error {
                MergeOnlineError::Conflict(conflicts) => {
                    PushReject::before_workspace_change(format!(
                        "fetch first: server has newer online updates that conflict with pushed commits: {}",
                        conflicts.into_iter().take(8).collect::<Vec<_>>().join(", ")
                    ))
                }
                failure => PushReject::internal_before_workspace_change(failure.to_string()),
            })?;
        let temp_dir = tempfile::tempdir().map_err(|temp_error| {
            PushReject::internal_before_workspace_change(temp_error.to_string())
        })?;
        materialize_merge_map_to_dir(temp_dir.path(), &merged_map)
            .map_err(|error| PushReject::internal_before_workspace_change(error.to_string()))?;
        sync_repo_documents_to_project(
            &self.state.db,
            self.state.storage.as_ref(),
            &self.state.collaboration,
            self.project_id,
            &temp_dir.path().to_string_lossy(),
            Some(self.workspace_before.workspace_version),
        )
        .await
        .map_err(|error| match error {
            RepositoryImportError::WorkspaceChanged => PushReject::before_workspace_change(
                "fetch first: workspace changed while the push was running",
            ),
            RepositoryImportError::MissingEntryFile { .. } => {
                PushReject::before_workspace_change(MISSING_ENTRY_FILE_PUSH_MESSAGE)
            }
            failure => PushReject::internal_after_workspace_change(failure.to_string()),
        })?;
        let materialized_workspace_version = sync_project_documents_to_repo(
            &self.state.db,
            self.state.storage.as_ref(),
            self.project_id,
            &self.config.local_path,
        )
        .await
        .map_err(|error| PushReject::internal_after_workspace_change(error.to_string()))?;
        let is_clean = worktree_is_clean(&self.config.local_path).unwrap_or(false);
        crate::versioning::record_receive_pack_sync(
            &self.state.db,
            self.project_id,
            materialized_workspace_version,
            !is_clean,
            is_clean,
        )
        .await
        .map_err(|sync_error| {
            PushReject::internal_after_workspace_change(format!(
                "merged receive-pack state persistence failed: {sync_error:?}"
            ))
        })?;
        record_event(
            &self.state.db,
            Some(self.actor),
            "git.receive_pack.accepted.merged_online_delta",
            serde_json::json!({"project_id": self.project_id}),
        )
        .await;
        Ok(())
    }

    async fn build_merged_workspace(
        &self,
        head_after: Option<git2::Oid>,
    ) -> Result<HashMap<String, MergeFileValue>, MergeOnlineError> {
        let old_head = self
            .head_before
            .ok_or(MergeOnlineError::MissingHead { head: "previous" })?;
        let new_head = head_after.ok_or(MergeOnlineError::MissingHead { head: "updated" })?;
        let (base_state, pushed_state) = {
            let repo = Repository::open(&self.config.local_path)
                .map_err(|source| MergeOnlineError::Git { source })?;
            let base_commit = repo
                .find_commit(old_head)
                .map_err(|source| MergeOnlineError::Git { source })?;
            let pushed_commit = repo
                .find_commit(new_head)
                .map_err(|source| MergeOnlineError::Git { source })?;
            let base_state = load_git_state_from_commit(&repo, &base_commit)
                .map_err(|source| MergeOnlineError::RevisionState { source })?;
            let pushed_state = load_git_state_from_commit(&repo, &pushed_commit)
                .map_err(|source| MergeOnlineError::RevisionState { source })?;
            (base_state, pushed_state)
        };
        let base_map = git_revision_state_to_merge_map(base_state);
        let pushed_map = git_revision_state_to_merge_map(pushed_state);
        let repo = Repository::open(&self.config.local_path)
            .map_err(|source| MergeOnlineError::Git { source })?;
        match merge_online_over_pushed(&repo, &base_map, &pushed_map, &self.workspace_before.files)
        {
            MergeWorkspaceResult::Merged(files) => Ok(files),
            MergeWorkspaceResult::Conflicts(paths) => Err(MergeOnlineError::Conflict(paths)),
        }
    }

    async fn import_pushed_workspace(&self) -> Result<(), PushReject> {
        let applied_workspace_version = match sync_repo_documents_to_project(
            &self.state.db,
            self.state.storage.as_ref(),
            &self.state.collaboration,
            self.project_id,
            &self.config.local_path,
            Some(self.workspace_before.workspace_version),
        )
        .await
        {
            Ok(workspace_version) => workspace_version,
            Err(RepositoryImportError::WorkspaceChanged) => {
                return Err(PushReject::before_workspace_change(
                    "fetch first: workspace changed while the push was running",
                ));
            }
            Err(RepositoryImportError::MissingEntryFile { .. }) => {
                return Err(PushReject::before_workspace_change(
                    MISSING_ENTRY_FILE_PUSH_MESSAGE,
                ));
            }
            Err(import_error) => {
                if let Err(sync_error) = crate::versioning::record_receive_pack_import_failure(
                    &self.state.db,
                    self.project_id,
                )
                .await
                {
                    error!(
                        ?sync_error,
                        project_id = %self.project_id,
                        "receive-pack failure state persistence failed"
                    );
                }
                let diagnostic = import_error.to_string();
                record_event(
                    &self.state.db,
                    Some(self.actor),
                    "git.receive_pack.import_failed",
                    serde_json::json!({
                        "project_id": self.project_id,
                        "error": &diagnostic
                    }),
                )
                .await;
                return Err(PushReject::internal_after_workspace_change(diagnostic));
            }
        };
        crate::versioning::record_receive_pack_sync(
            &self.state.db,
            self.project_id,
            applied_workspace_version,
            false,
            true,
        )
        .await
        .map_err(|sync_error| {
            PushReject::internal_after_workspace_change(format!(
                "accepted receive-pack state persistence failed: {sync_error:?}"
            ))
        })?;
        record_event(
            &self.state.db,
            Some(self.actor),
            "git.receive_pack.accepted",
            serde_json::json!({"project_id": self.project_id}),
        )
        .await;
        Ok(())
    }

    async fn restore_rejected_push(
        &self,
        restore_workspace: bool,
    ) -> Result<(), ReceivePackRecoveryError> {
        restore_head(
            &self.config.local_path,
            &self.config.default_branch,
            self.head_before,
        )
        .map_err(|source| ReceivePackRecoveryError::RestoreHead {
            project_id: self.project_id,
            source,
        })?;
        if restore_workspace {
            let current_workspace_version =
                crate::workspace::load_project_content_snapshot(&self.state.db, self.project_id)
                    .await
                    .map_err(|source| ReceivePackRecoveryError::Persistence {
                        stage: ReceivePackRecoveryPersistenceStage::LoadWorkspaceSnapshot,
                        project_id: self.project_id,
                        source,
                    })?
                    .ok_or(ReceivePackRecoveryError::ProjectNotFound {
                        project_id: self.project_id,
                    })?
                    .workspace_version;
            if current_workspace_version
                == self.workspace_before.workspace_version.saturating_add(1)
            {
                let restore_dir =
                    tempfile::tempdir().map_err(|source| ReceivePackRecoveryError::Filesystem {
                        project_id: self.project_id,
                        source,
                    })?;
                materialize_merge_map_to_dir(restore_dir.path(), &self.workspace_before.files)
                    .map_err(|source| ReceivePackRecoveryError::Filesystem {
                        project_id: self.project_id,
                        source,
                    })?;
                sync_repo_documents_to_project(
                    &self.state.db,
                    self.state.storage.as_ref(),
                    &self.state.collaboration,
                    self.project_id,
                    &restore_dir.path().to_string_lossy(),
                    Some(current_workspace_version),
                )
                .await
                .map_err(|source| ReceivePackRecoveryError::RepositoryImport {
                    project_id: self.project_id,
                    source,
                })?;
            } else if current_workspace_version != self.workspace_before.workspace_version {
                error!(
                    project_id = %self.project_id,
                    snapshot_version = self.workspace_before.workspace_version,
                    current_workspace_version,
                    "preserving newer Workspace edits instead of restoring the pre-push snapshot"
                );
            }
        }
        let current_config = crate::versioning::load_repository(&self.state.db, self.project_id)
            .await
            .map_err(|source| ReceivePackRecoveryError::Persistence {
                stage: ReceivePackRecoveryPersistenceStage::LoadRepository,
                project_id: self.project_id,
                source,
            })?
            .ok_or(ReceivePackRecoveryError::RepositoryNotFound {
                project_id: self.project_id,
            })?;
        if current_config.pending_sync {
            crate::versioning::flush_pending_server_commit(
                &self.state.db,
                self.state.storage.as_ref(),
                &self.state.distribution,
                self.project_id,
                Some(self.actor),
                None,
                None,
            )
            .await
            .map_err(|source| ReceivePackRecoveryError::Flush {
                project_id: self.project_id,
                source,
            })
        } else {
            let materialized_workspace_version = sync_project_documents_to_repo(
                &self.state.db,
                self.state.storage.as_ref(),
                self.project_id,
                &self.config.local_path,
            )
            .await
            .map_err(
                |source| ReceivePackRecoveryError::WorkspaceMaterialization {
                    project_id: self.project_id,
                    source,
                },
            )?;
            crate::versioning::record_receive_pack_sync(
                &self.state.db,
                self.project_id,
                materialized_workspace_version,
                false,
                true,
            )
            .await
            .map(|_| ())
            .map_err(|source| ReceivePackRecoveryError::Persistence {
                stage: ReceivePackRecoveryPersistenceStage::RecordSync,
                project_id: self.project_id,
                source,
            })
        }
    }

    fn rejection_response(&self, reason: &str) -> Response<Body> {
        let ref_name = format!("refs/heads/{}", self.config.default_branch);
        let hint_lines = push_reject_hint_lines(reason);
        let body = git_receive_pack_reject_body(&ref_name, reason, &hint_lines);
        let builder = Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                "application/x-git-receive-pack-result",
            )
            .header("Cache-Control", "no-cache");
        builder
            .body(Body::from(body))
            .unwrap_or_else(|_| Response::new(Body::from("backend response error")))
    }
}

fn validate_default_ref_update(
    repo_path: &str,
    head_before: Option<git2::Oid>,
    head_after: Option<git2::Oid>,
) -> Result<(), DefaultRefUpdateRejection> {
    match (head_before, head_after) {
        (Some(_), None) => Err(DefaultRefUpdateRejection::BranchDeletion),
        (Some(old_head), Some(new_head))
            if !is_ancestor(repo_path, old_head, new_head).unwrap_or(false) =>
        {
            Err(DefaultRefUpdateRejection::NonFastForward)
        }
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DefaultRefUpdateRejection {
    BranchDeletion,
    NonFastForward,
}

impl DefaultRefUpdateRejection {
    const fn message(self) -> &'static str {
        match self {
            Self::BranchDeletion => "default branch deletion prohibited",
            Self::NonFastForward => "forced push prohibited",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::versioning::authors::GitIdentity;
    use crate::versioning::commit::commit_staged_if_changed;
    use crate::versioning::local_repository::ensure_initialized;

    #[test]
    fn default_ref_validation_accepts_fast_forward_and_rejects_rewind_or_delete(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let repo_path = temp.path().to_string_lossy().to_string();
        let author =
            GitIdentity::account("Owner", "owner@example.com", "Owner", "owner@example.com");
        let committer = GitIdentity::service("Workspace", "workspace.local");
        ensure_initialized(&repo_path, "main")?;
        std::fs::write(temp.path().join("main.typ"), "one")?;
        commit_staged_if_changed(&repo_path, "first", &author, &committer)?;
        let first =
            head_oid(&repo_path)?.ok_or_else(|| std::io::Error::other("first head is missing"))?;
        std::fs::write(temp.path().join("main.typ"), "two")?;
        commit_staged_if_changed(&repo_path, "second", &author, &committer)?;
        let second =
            head_oid(&repo_path)?.ok_or_else(|| std::io::Error::other("second head is missing"))?;

        assert_eq!(
            validate_default_ref_update(&repo_path, Some(first), Some(second)),
            Ok(())
        );
        assert_eq!(
            validate_default_ref_update(&repo_path, Some(second), Some(first)),
            Err(DefaultRefUpdateRejection::NonFastForward)
        );
        assert_eq!(
            validate_default_ref_update(&repo_path, Some(second), None),
            Err(DefaultRefUpdateRejection::BranchDeletion)
        );
        assert_eq!(
            validate_default_ref_update(&repo_path, None, Some(first)),
            Ok(())
        );
        Ok(())
    }

    #[test]
    fn internal_push_failure_hides_diagnostics_from_the_client() {
        let rejection = PushReject::internal_after_workspace_change(
            "database connection failed at internal-host:5432",
        );

        assert_eq!(rejection.reason, "server could not apply pushed content");
        assert!(rejection.workspace_may_have_changed);
        assert!(rejection.diagnostic.is_some());
    }
}
