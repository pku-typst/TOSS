//! Coherent Workspace capture and deterministic `project-bundle/v1` creation.

use super::persistence::{pin_project_assets, release_project_asset_pins};
use super::ProcessingOperation;
use crate::collaboration::{CollaborationContext, FlushProjectCollaborationError};
use crate::object_storage::ObjectStorage;
use crate::workspace::{
    load_project_content_asset_bytes, lock_processing_project_snapshot,
    lock_project_content_exclusively, LatexEngine, LoadProjectContentAssetError,
    ProjectContentSnapshot, ProjectType,
};
use chrono::Utc;
use futures::{StreamExt, TryStreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashSet;
use std::io::Write;
use thiserror::Error;
use uuid::Uuid;

const MAX_PROJECT_FILES: usize = 4096;
const ASSET_READ_CONCURRENCY: usize = 8;

pub(super) struct CapturedProjectBundle {
    pub schema: &'static str,
    pub media_type: &'static str,
    pub bytes: Vec<u8>,
    pub digest: [u8; 32],
    pub workspace_version: i64,
    pub content_epoch: i64,
    pub source_epoch: i64,
    pub project_type: ProjectType,
    pub entry_file_path: String,
    pub latex_engine: Option<LatexEngine>,
}

pub(super) struct ProjectBundleCapture<'a> {
    pub db: &'a PgPool,
    pub storage: Option<&'a ObjectStorage>,
    pub collaboration: &'a CollaborationContext,
    pub operation: ProcessingOperation,
    pub job_id: Uuid,
    pub project_id: Uuid,
    pub max_input_bytes: i64,
}

#[derive(Debug, Error)]
pub(super) enum CaptureProjectBundleError {
    #[error("project was not found")]
    ProjectNotFound,
    #[error("project entry file was not found in the captured content")]
    EntryFileNotFound,
    #[error("project contains duplicate document and asset paths")]
    DuplicatePath,
    #[error("project contains too many files")]
    TooManyFiles,
    #[error("project input exceeds the configured processing limit")]
    TooLarge,
    #[error("collaboration state could not be captured")]
    Collaboration(#[source] FlushProjectCollaborationError),
    #[error("Workspace capture failed")]
    Persistence(#[source] sqlx::Error),
    #[error(transparent)]
    Asset(#[from] LoadProjectContentAssetError),
    #[error("project manifest could not be encoded")]
    Manifest(#[source] serde_json::Error),
    #[error("project archive could not be created")]
    Archive(#[source] BundleArchiveError),
}

#[derive(Debug, Error)]
pub(super) enum BundleArchiveError {
    #[error("archive entry could not be started: {path}")]
    Start {
        path: String,
        #[source]
        source: zip::result::ZipError,
    },
    #[error("archive entry could not be written: {path}")]
    Write {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("archive could not be finalized")]
    Finish(#[source] zip::result::ZipError),
}

#[derive(Serialize)]
struct ProjectBundleManifest {
    schema: &'static str,
    project_type: ProjectType,
    entry_file_path: String,
    latex_engine: Option<LatexEngine>,
    workspace_version: i64,
    content_generation: i64,
    source_epoch: i64,
    files: Vec<ProjectBundleFile>,
}

#[derive(Serialize)]
struct ProjectBundleFile {
    path: String,
    kind: &'static str,
    size_bytes: usize,
    sha256: String,
}

struct BundleFile {
    path: String,
    kind: &'static str,
    bytes: Vec<u8>,
}

pub(super) async fn capture_project_bundle(
    capture: ProjectBundleCapture<'_>,
) -> Result<CapturedProjectBundle, CaptureProjectBundleError> {
    let ProjectBundleCapture {
        db,
        storage,
        collaboration,
        operation,
        job_id,
        project_id,
        max_input_bytes,
    } = capture;
    let snapshot = capture_project_snapshot(db, collaboration, job_id, project_id).await?;
    let contract = operation.contract();
    let result = materialize_bundle(
        storage,
        snapshot,
        contract.input_schema,
        contract.input_media_type,
        max_input_bytes,
    )
    .await;
    release_pins(db, job_id).await;
    result
}

async fn capture_project_snapshot(
    db: &PgPool,
    collaboration: &CollaborationContext,
    job_id: Uuid,
    project_id: Uuid,
) -> Result<ProjectContentSnapshot, CaptureProjectBundleError> {
    let mut transaction = db
        .begin()
        .await
        .map_err(CaptureProjectBundleError::Persistence)?;
    lock_project_content_exclusively(&mut transaction, project_id)
        .await
        .map_err(CaptureProjectBundleError::Persistence)?;
    let changes = collaboration
        .flush_project_collaboration_for_capture(&mut transaction, project_id)
        .await
        .map_err(CaptureProjectBundleError::Collaboration)?;
    let snapshot = lock_processing_project_snapshot(&mut transaction, project_id)
        .await
        .map_err(CaptureProjectBundleError::Persistence)?
        .ok_or(CaptureProjectBundleError::ProjectNotFound)?;
    let object_keys = snapshot
        .assets
        .values()
        .map(|asset| asset.object_key.clone())
        .collect::<Vec<_>>();
    pin_project_assets(&mut transaction, job_id, &object_keys, Utc::now())
        .await
        .map_err(CaptureProjectBundleError::Persistence)?;
    transaction
        .commit()
        .await
        .map_err(CaptureProjectBundleError::Persistence)?;
    for change in changes {
        collaboration.workspace_changed(project_id, change).await;
    }
    Ok(snapshot)
}

async fn release_pins(db: &PgPool, job_id: Uuid) {
    if let Err(error) = release_project_asset_pins(db, job_id).await {
        tracing::warn!(%job_id, %error, "processing input asset pins could not be released");
    }
}

async fn materialize_bundle(
    storage: Option<&ObjectStorage>,
    snapshot: ProjectContentSnapshot,
    schema: &'static str,
    media_type: &'static str,
    max_input_bytes: i64,
) -> Result<CapturedProjectBundle, CaptureProjectBundleError> {
    let asset_files = futures::stream::iter(snapshot.assets)
        .map(|(path, asset)| async move {
            let bytes = load_project_content_asset_bytes(storage, &asset).await?;
            Ok::<_, LoadProjectContentAssetError>(BundleFile {
                path,
                kind: "asset",
                bytes,
            })
        })
        .buffered(ASSET_READ_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    let mut files = snapshot
        .documents
        .into_iter()
        .map(|(path, content)| BundleFile {
            path,
            kind: "document",
            bytes: content.into_bytes(),
        })
        .chain(asset_files)
        .collect::<Vec<_>>();
    if files.len() > MAX_PROJECT_FILES {
        return Err(CaptureProjectBundleError::TooManyFiles);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let unique_paths = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<HashSet<_>>();
    if unique_paths.len() != files.len() {
        return Err(CaptureProjectBundleError::DuplicatePath);
    }
    if !files
        .iter()
        .any(|file| file.kind == "document" && file.path == snapshot.entry_file_path)
    {
        return Err(CaptureProjectBundleError::EntryFileNotFound);
    }
    let expanded_bytes =
        files
            .iter()
            .map(|file| file.bytes.len())
            .try_fold(0_i64, |total, size| {
                i64::try_from(size)
                    .ok()
                    .and_then(|size| total.checked_add(size))
            });
    if expanded_bytes.is_none_or(|size| size > max_input_bytes) {
        return Err(CaptureProjectBundleError::TooLarge);
    }
    let manifest = ProjectBundleManifest {
        schema,
        project_type: snapshot.project_type,
        entry_file_path: snapshot.entry_file_path.clone(),
        latex_engine: snapshot.latex_engine,
        workspace_version: snapshot.workspace_version,
        content_generation: snapshot.content_epoch,
        source_epoch: snapshot.source_epoch,
        files: files
            .iter()
            .map(|file| ProjectBundleFile {
                path: file.path.clone(),
                kind: file.kind,
                size_bytes: file.bytes.len(),
                sha256: hex::encode(Sha256::digest(&file.bytes)),
            })
            .collect(),
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(CaptureProjectBundleError::Manifest)?;
    let bytes =
        build_bundle_zip(&manifest_bytes, files).map_err(CaptureProjectBundleError::Archive)?;
    if i64::try_from(bytes.len()).map_or(true, |size| size > max_input_bytes) {
        return Err(CaptureProjectBundleError::TooLarge);
    }
    let digest = Sha256::digest(&bytes).into();
    Ok(CapturedProjectBundle {
        schema,
        media_type,
        bytes,
        digest,
        workspace_version: snapshot.workspace_version,
        content_epoch: snapshot.content_epoch,
        source_epoch: snapshot.source_epoch,
        project_type: snapshot.project_type,
        entry_file_path: snapshot.entry_file_path,
        latex_engine: snapshot.latex_engine,
    })
}

fn build_bundle_zip(
    manifest: &[u8],
    files: Vec<BundleFile>,
) -> Result<Vec<u8>, BundleArchiveError> {
    let cursor = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    write_entry(&mut zip, "manifest.json", manifest, options)?;
    for file in files {
        let archive_path = format!("project/{}", file.path);
        write_entry(&mut zip, &archive_path, &file.bytes, options)?;
    }
    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(BundleArchiveError::Finish)
}

fn write_entry(
    zip: &mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>,
    path: &str,
    bytes: &[u8],
    options: zip::write::SimpleFileOptions,
) -> Result<(), BundleArchiveError> {
    zip.start_file(path, options)
        .map_err(|source| BundleArchiveError::Start {
            path: path.to_string(),
            source,
        })?;
    zip.write_all(bytes)
        .map_err(|source| BundleArchiveError::Write {
            path: path.to_string(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::{build_bundle_zip, BundleFile};

    #[test]
    fn project_bundle_zip_is_deterministic() -> Result<(), Box<dyn std::error::Error>> {
        let files = || {
            vec![BundleFile {
                path: "main.tex".to_string(),
                kind: "document",
                bytes: b"hello".to_vec(),
            }]
        };
        assert_eq!(
            build_bundle_zip(br#"{"schema":"project-bundle/v1"}"#, files())?,
            build_bundle_zip(br#"{"schema":"project-bundle/v1"}"#, files())?
        );
        Ok(())
    }
}
