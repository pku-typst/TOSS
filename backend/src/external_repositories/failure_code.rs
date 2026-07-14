//! Stable, user-visible failure reasons owned by External Repositories.

use crate::text_enum::text_enum;

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ExternalGitFailureCode {
        CheckpointBranchMoved => "checkpoint_branch_moved",
        GitAuthorizationRequired => "git_authorization_required",
        GitPermissionDenied => "git_permission_denied",
        GitProviderUnavailable => "git_provider_unavailable",
        GitCommandTimeout => "git_command_timeout",
        GitPushVerificationFailed => "git_push_verification_failed",
        GitCheckpointFailed => "git_checkpoint_failed",
        GitCommandFailed => "git_command_failed",
        GitRepositoryNotFound => "git_repository_not_found",
        GitFetchFailed => "git_fetch_failed",
        RepositoryContentUnreadable => "repository_content_unreadable",
        RepositorySymlinksNotSupported => "repository_symlinks_not_supported",
        RepositorySubmodulesNotSupported => "repository_submodules_not_supported",
        RepositorySpecialFilesNotSupported => "repository_special_files_not_supported",
        RepositoryFileLimitExceeded => "repository_file_limit_exceeded",
        RepositoryFileSizeLimitExceeded => "repository_file_size_limit_exceeded",
        RepositoryTotalSizeLimitExceeded => "repository_total_size_limit_exceeded",
        RepositoryPathInvalid => "repository_path_invalid",
        RepositoryLfsObjectMissing => "repository_lfs_object_missing",
        RepositoryTextEncodingInvalid => "repository_text_encoding_invalid",
        RepositoryMissingEntryFile => "repository_missing_entry_file",
        RepositoryIsEmpty => "repository_is_empty",
        RepositoryRevisionInvalid => "repository_revision_invalid",
        RepositoryImportStateFailed => "repository_import_state_failed",
        RepositoryAssetStoreFailed => "repository_asset_store_failed",
        RepositoryApplyFailed => "repository_apply_failed",
        RepositoryRevisionFailed => "repository_revision_failed",
        ProjectNotFound => "project_not_found",
        ExternalGitLinkMissing => "external_git_link_missing",
    }
}

#[cfg(test)]
mod tests {
    use super::ExternalGitFailureCode;

    #[test]
    fn failure_codes_reject_unknown_persisted_values() {
        assert_eq!(
            "repository_apply_failed".parse(),
            Ok(ExternalGitFailureCode::RepositoryApplyFailed)
        );
        assert_eq!(
            "arbitrary_failure".parse::<ExternalGitFailureCode>(),
            Err(())
        );
    }
}
