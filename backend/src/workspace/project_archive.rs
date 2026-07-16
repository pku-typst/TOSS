//! Project ZIP archive construction from a consistent Workspace snapshot.

use super::{
    load_project_content_asset_bytes, load_project_content_snapshot, LoadProjectContentAssetError,
};
use crate::collaboration::{CollaborationContext, FlushProjectCollaborationError};
use crate::object_storage::ObjectStorage;
use futures::{StreamExt, TryStreamExt};
use sqlx::PgPool;
use std::io::Write;
use thiserror::Error;
use uuid::Uuid;

const ARCHIVE_ASSET_READ_CONCURRENCY: usize = 8;

#[derive(Debug, Error)]
pub(super) enum BuildZipError {
    #[error("archive entry could not be started: {path}")]
    StartEntry {
        path: String,
        #[source]
        source: zip::result::ZipError,
    },
    #[error("archive entry could not be written: {path}")]
    WriteEntry {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("archive could not be finalized")]
    Finish(#[source] zip::result::ZipError),
}

#[derive(Debug, Error)]
pub(super) enum CaptureCurrentProjectArchiveError {
    #[error("current collaboration state could not be captured for project {project_id}")]
    Collaboration {
        project_id: Uuid,
        #[source]
        source: FlushProjectCollaborationError,
    },
    #[error("project was not found")]
    ProjectNotFound,
    #[error("project archive source lookup failed for project {project_id}")]
    Persistence {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error(transparent)]
    Asset(#[from] LoadProjectContentAssetError),
    #[error("project archive worker failed for project {project_id}")]
    Worker {
        project_id: Uuid,
        #[source]
        source: tokio::task::JoinError,
    },
    #[error("project archive creation failed for project {project_id}")]
    Archive {
        project_id: Uuid,
        #[source]
        source: BuildZipError,
    },
}

pub(super) async fn capture_current_project_archive(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    collaboration: &CollaborationContext,
    project_id: Uuid,
) -> Result<Vec<u8>, CaptureCurrentProjectArchiveError> {
    collaboration
        .flush_project_collaboration(project_id)
        .await
        .map_err(|source| CaptureCurrentProjectArchiveError::Collaboration {
            project_id,
            source,
        })?;
    build_project_archive_from_workspace(db, storage, project_id).await
}

async fn build_project_archive_from_workspace(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    project_id: Uuid,
) -> Result<Vec<u8>, CaptureCurrentProjectArchiveError> {
    let snapshot = load_project_content_snapshot(db, project_id)
        .await
        .map_err(|source| CaptureCurrentProjectArchiveError::Persistence { project_id, source })?
        .ok_or(CaptureCurrentProjectArchiveError::ProjectNotFound)?;
    let asset_entries = futures::stream::iter(snapshot.assets)
        .map(|(path, stored)| async move {
            let bytes = load_project_content_asset_bytes(storage, &stored).await?;
            Ok::<_, LoadProjectContentAssetError>((path, bytes))
        })
        .buffered(ARCHIVE_ASSET_READ_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    let document_entries = snapshot
        .documents
        .into_iter()
        .map(|(path, content)| (path, content.into_bytes()))
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || build_zip(document_entries, asset_entries))
        .await
        .map_err(|source| CaptureCurrentProjectArchiveError::Worker { project_id, source })?
        .map_err(|source| CaptureCurrentProjectArchiveError::Archive { project_id, source })
}

fn build_zip(
    document_entries: Vec<(String, Vec<u8>)>,
    asset_entries: Vec<(String, Vec<u8>)>,
) -> Result<Vec<u8>, BuildZipError> {
    let mut entries = document_entries
        .into_iter()
        .chain(asset_entries)
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let cursor = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    for (path, bytes) in entries {
        zip.start_file(&path, options)
            .map_err(|source| BuildZipError::StartEntry {
                path: path.clone(),
                source,
            })?;
        zip.write_all(&bytes)
            .map_err(|source| BuildZipError::WriteEntry { path, source })?;
    }
    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(BuildZipError::Finish)
}

#[cfg(test)]
mod tests {
    use super::build_zip;
    use std::io::Read;

    #[test]
    fn zip_contains_documents_and_assets() -> Result<(), Box<dyn std::error::Error>> {
        let bytes = build_zip(
            vec![("main.typ".to_string(), b"hello".to_vec())],
            vec![("images/logo.bin".to_string(), vec![0, 1, 2])],
        )
        .map_err(std::io::Error::other)?;
        let reader = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader)?;
        let mut document = String::new();
        archive
            .by_name("main.typ")
            .and_then(|mut file| file.read_to_string(&mut document).map_err(Into::into))?;
        assert_eq!(document, "hello");
        let mut asset = Vec::new();
        archive
            .by_name("images/logo.bin")
            .and_then(|mut file| file.read_to_end(&mut asset).map_err(Into::into))?;
        assert_eq!(asset, vec![0, 1, 2]);
        Ok(())
    }

    #[test]
    fn zip_is_deterministic_across_input_order() -> Result<(), Box<dyn std::error::Error>> {
        let first = build_zip(
            vec![
                ("z.typ".to_string(), b"z".to_vec()),
                ("main.typ".to_string(), b"hello".to_vec()),
            ],
            vec![("images/logo.bin".to_string(), vec![0, 1, 2])],
        )
        .map_err(std::io::Error::other)?;
        let second = build_zip(
            vec![
                ("main.typ".to_string(), b"hello".to_vec()),
                ("z.typ".to_string(), b"z".to_vec()),
            ],
            vec![("images/logo.bin".to_string(), vec![0, 1, 2])],
        )
        .map_err(std::io::Error::other)?;

        assert_eq!(first, second);
        Ok(())
    }
}
