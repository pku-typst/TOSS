use super::*;
use crate::access::{
    AnonymousMode, OrganizationRole, ProjectAccessType, ProjectPermission, ProjectRole,
};
use crate::experience::ExperienceResourceKind;
use crate::external_repositories::{
    ExternalGitCheckpointPhase, ExternalGitGrantStatus, ExternalGitInboundOperation,
    ExternalGitInboundPhase, ExternalGitJobState, ExternalGitLinkStatus, ExternalGitProjectState,
    ExternalGitRepositoryVisibility, ProviderBrand, ProviderKind, RepositoryOwnerKind,
};
use crate::templates::TemplateSource;
use crate::versioning::{GitSyncStatus, RevisionBaseAnchor, RevisionTransferMode};
use crate::workspace::{LatexEngine, ProjectFileKind, ProjectType};
use serde::Serialize;

macro_rules! assert_enum_schema {
    ($document:expr, $name:literal, $($value:path),+ $(,)?) => {
        compare_enum_schema($document, $name, &[$($value),+])?
    };
}

#[test]
fn checked_in_openapi_document_is_current() -> Result<(), serde_json::Error> {
    let mut actual = serde_json::to_string_pretty(&openapi_document())?;
    actual.push('\n');
    assert_eq!(include_str!("../../../../protocol/openapi.json"), actual);
    Ok(())
}

#[test]
fn openapi_enum_values_match_wire_serialization() -> Result<(), String> {
    let document = serde_json::to_value(openapi_document()).map_err(|error| error.to_string())?;

    assert_enum_schema!(
        &document,
        "AnonymousMode",
        AnonymousMode::Off,
        AnonymousMode::ReadOnly,
        AnonymousMode::ReadWriteNamed,
    );
    assert_enum_schema_round_trip::<ApiErrorCode>(&document, "ApiErrorCode")?;
    assert_enum_schema!(
        &document,
        "ExperienceResourceKind",
        ExperienceResourceKind::Documentation,
        ExperienceResourceKind::Packages,
        ExperienceResourceKind::Repository,
        ExperienceResourceKind::Support,
        ExperienceResourceKind::Status,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitCheckpointPhase",
        ExternalGitCheckpointPhase::Queued,
        ExternalGitCheckpointPhase::Snapshot,
        ExternalGitCheckpointPhase::CommitLocal,
        ExternalGitCheckpointPhase::PushGit,
    );
    assert_enum_schema!(
        &document,
        "ProviderBrand",
        ProviderBrand::Identity,
        ProviderBrand::GitHub,
        ProviderBrand::GitLab,
        ProviderBrand::Gitea,
        ProviderBrand::Forgejo,
        ProviderBrand::Codeberg,
    );
    assert_enum_schema!(
        &document,
        "ProviderKind",
        ProviderKind::GitHub,
        ProviderKind::GitLab,
        ProviderKind::Gitea,
        ProviderKind::Forgejo,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitGrantStatus",
        ExternalGitGrantStatus::Active,
        ExternalGitGrantStatus::ReauthRequired,
        ExternalGitGrantStatus::Revoked,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitInboundOperation",
        ExternalGitInboundOperation::Import,
        ExternalGitInboundOperation::Sync,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitInboundPhase",
        ExternalGitInboundPhase::Queued,
        ExternalGitInboundPhase::Fetch,
        ExternalGitInboundPhase::Lfs,
        ExternalGitInboundPhase::Validate,
        ExternalGitInboundPhase::Assets,
        ExternalGitInboundPhase::Apply,
        ExternalGitInboundPhase::Revision,
        ExternalGitInboundPhase::Complete,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitJobState",
        ExternalGitJobState::Pending,
        ExternalGitJobState::Processing,
        ExternalGitJobState::RetryWait,
        ExternalGitJobState::Paused,
        ExternalGitJobState::Failed,
        ExternalGitJobState::Succeeded,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitLinkStatus",
        ExternalGitLinkStatus::Linking,
        ExternalGitLinkStatus::Active,
        ExternalGitLinkStatus::ReauthRequired,
        ExternalGitLinkStatus::Conflict,
        ExternalGitLinkStatus::Error,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitProjectState",
        ExternalGitProjectState::Unlinked,
        ExternalGitProjectState::Linking,
        ExternalGitProjectState::Active,
        ExternalGitProjectState::ReauthRequired,
        ExternalGitProjectState::Conflict,
        ExternalGitProjectState::Error,
        ExternalGitProjectState::Syncing,
        ExternalGitProjectState::RetryWait,
        ExternalGitProjectState::Pending,
        ExternalGitProjectState::Dirty,
    );
    assert_enum_schema!(
        &document,
        "ExternalGitRepositoryVisibility",
        ExternalGitRepositoryVisibility::Private,
        ExternalGitRepositoryVisibility::Internal,
        ExternalGitRepositoryVisibility::Public,
    );
    assert_enum_schema!(
        &document,
        "GitSyncStatus",
        GitSyncStatus::Clean,
        GitSyncStatus::ReceivePackImportFailed,
    );
    assert_enum_schema!(
        &document,
        "LatexEngine",
        LatexEngine::Pdftex,
        LatexEngine::Xetex,
    );
    assert_enum_schema!(
        &document,
        "OrganizationRole",
        OrganizationRole::Owner,
        OrganizationRole::Member,
    );
    assert_enum_schema!(
        &document,
        "ProjectAccessType",
        ProjectAccessType::Read,
        ProjectAccessType::Write,
        ProjectAccessType::Manage,
    );
    assert_enum_schema!(
        &document,
        "ProjectFileKind",
        ProjectFileKind::File,
        ProjectFileKind::Directory,
    );
    assert_enum_schema!(
        &document,
        "ProjectPermission",
        ProjectPermission::Read,
        ProjectPermission::Write,
    );
    assert_enum_schema!(
        &document,
        "ProjectRole",
        ProjectRole::Owner,
        ProjectRole::ReadWrite,
        ProjectRole::ReadOnly,
    );
    assert_enum_schema!(
        &document,
        "ProjectType",
        ProjectType::Typst,
        ProjectType::Latex,
    );
    assert_enum_schema!(
        &document,
        "RepositoryOwnerKind",
        RepositoryOwnerKind::User,
        RepositoryOwnerKind::Organization,
    );
    assert_enum_schema!(
        &document,
        "RealtimeServerEventKind",
        crate::protocol::RealtimeServerEventKind::YjsUpdate,
        crate::protocol::RealtimeServerEventKind::YjsSync,
        crate::protocol::RealtimeServerEventKind::YjsAck,
        crate::protocol::RealtimeServerEventKind::PresenceJoin,
        crate::protocol::RealtimeServerEventKind::PresenceLeave,
        crate::protocol::RealtimeServerEventKind::PresenceMetadata,
        crate::protocol::RealtimeServerEventKind::PresenceCursor,
        crate::protocol::RealtimeServerEventKind::BootstrapDone,
        crate::protocol::RealtimeServerEventKind::WorkspaceChanged,
        crate::protocol::RealtimeServerEventKind::DocumentChanged,
        crate::protocol::RealtimeServerEventKind::ProjectReplaced,
        crate::protocol::RealtimeServerEventKind::AccessChanged,
        crate::protocol::RealtimeServerEventKind::ServerError,
    );
    assert_enum_schema!(
        &document,
        "RealtimeWorkspaceChangeScope",
        crate::protocol::RealtimeWorkspaceChangeScope::Document,
        crate::protocol::RealtimeWorkspaceChangeScope::Tree,
        crate::protocol::RealtimeWorkspaceChangeScope::Settings,
        crate::protocol::RealtimeWorkspaceChangeScope::Assets,
    );
    assert_enum_schema!(
        &document,
        "RevisionBaseAnchor",
        RevisionBaseAnchor::None,
        RevisionBaseAnchor::Live,
        RevisionBaseAnchor::Revision,
    );
    assert_enum_schema!(
        &document,
        "RevisionTransferMode",
        RevisionTransferMode::Full,
        RevisionTransferMode::Delta,
    );
    assert_enum_schema!(
        &document,
        "TemplateSource",
        TemplateSource::Builtin,
        TemplateSource::Personal,
        TemplateSource::Shared,
    );

    Ok(())
}

fn compare_enum_schema<T: Serialize>(
    document: &serde_json::Value,
    schema_name: &str,
    values: &[T],
) -> Result<(), String> {
    let Some(schema_values) = document
        .get("components")
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.get(schema_name))
        .and_then(|value| value.get("enum"))
        .and_then(serde_json::Value::as_array)
    else {
        return Err(format!("OpenAPI enum schema is missing: {schema_name}"));
    };
    let wire_values = values
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    assert_eq!(schema_values, &wire_values, "schema {schema_name}");
    Ok(())
}

fn assert_enum_schema_round_trip<T>(
    document: &serde_json::Value,
    schema_name: &str,
) -> Result<(), String>
where
    T: serde::de::DeserializeOwned + Serialize,
{
    let Some(schema_values) = document
        .get("components")
        .and_then(|value| value.get("schemas"))
        .and_then(|value| value.get(schema_name))
        .and_then(|value| value.get("enum"))
        .and_then(serde_json::Value::as_array)
    else {
        return Err(format!("OpenAPI enum schema is missing: {schema_name}"));
    };
    for schema_value in schema_values {
        let value = serde_json::from_value::<T>(schema_value.clone())
            .map_err(|error| format!("schema {schema_name}: {error}"))?;
        let wire_value = serde_json::to_value(value).map_err(|error| error.to_string())?;
        if wire_value != *schema_value {
            return Err(format!(
                "schema {schema_name} value {schema_value} serializes as {wire_value}"
            ));
        }
    }
    Ok(())
}
