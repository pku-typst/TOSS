//! Validation and materialization of the worker-produced `workspace-bundle/v1` contract.

use crate::workspace::{
    is_document_text_path, sanitize_project_path, ProjectType, WorkspaceDocument,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::Path;
use thiserror::Error;

const SCHEMA: &str = "workspace-bundle/v1";
const MAX_FILES: usize = 4096;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

pub(super) struct ValidatedWorkspaceBundle {
    pub entry_file_path: String,
    pub directories: Vec<String>,
    pub documents: Vec<WorkspaceDocument>,
    pub assets: Vec<WorkspaceBundleAsset>,
}

pub(super) struct WorkspaceBundleAsset {
    pub path: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub(super) enum WorkspaceBundleError {
    #[error("Workspace bundle is not a readable ZIP archive")]
    Archive,
    #[error("Workspace bundle contains an unsafe or duplicate path")]
    UnsafePath,
    #[error("Workspace bundle exceeds structural limits")]
    Limit,
    #[error("Workspace bundle manifest is invalid")]
    Manifest,
    #[error("Workspace bundle content does not match its manifest")]
    ManifestMismatch,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceBundleManifest {
    schema: String,
    project_type: ProjectType,
    entry_file_path: String,
    files: Vec<WorkspaceBundleFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceBundleFile {
    path: String,
    kind: String,
    #[serde(default)]
    media_type: Option<String>,
    size_bytes: i64,
    sha256: String,
}

pub(super) fn validate_workspace_bundle(
    content: &[u8],
    max_expanded_bytes: u64,
) -> Result<ValidatedWorkspaceBundle, WorkspaceBundleError> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(content)).map_err(|_| WorkspaceBundleError::Archive)?;
    if archive.is_empty() || archive.len() > MAX_FILES + 1 {
        return Err(WorkspaceBundleError::Limit);
    }
    let mut archive_names = HashSet::with_capacity(archive.len());
    let mut project_files = HashMap::with_capacity(archive.len().saturating_sub(1));
    let mut manifest_bytes = None;
    let mut expanded_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| WorkspaceBundleError::Archive)?;
        let name = entry.name().to_string();
        if entry.is_dir() || !safe_archive_name(&name) || !archive_names.insert(name.clone()) {
            return Err(WorkspaceBundleError::UnsafePath);
        }
        let mode = entry.unix_mode().unwrap_or(0o100644);
        if !matches!(mode & 0o170000, 0 | 0o100000) {
            return Err(WorkspaceBundleError::UnsafePath);
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.size())
            .ok_or(WorkspaceBundleError::Limit)?;
        if expanded_bytes > max_expanded_bytes {
            return Err(WorkspaceBundleError::Limit);
        }
        let per_file_limit = if name == "manifest.json" {
            MAX_MANIFEST_BYTES.min(max_expanded_bytes)
        } else {
            max_expanded_bytes
        };
        let bytes = read_bounded(&mut entry, per_file_limit)?;
        if name == "manifest.json" {
            manifest_bytes = Some(bytes);
            continue;
        }
        let path = name
            .strip_prefix("project/")
            .ok_or(WorkspaceBundleError::UnsafePath)?;
        let path = sanitize_project_path(path).map_err(|_| WorkspaceBundleError::UnsafePath)?;
        if project_files.insert(path, bytes).is_some() {
            return Err(WorkspaceBundleError::UnsafePath);
        }
    }
    let manifest: WorkspaceBundleManifest = serde_json::from_slice(
        manifest_bytes
            .as_deref()
            .ok_or(WorkspaceBundleError::Manifest)?,
    )
    .map_err(|_| WorkspaceBundleError::Manifest)?;
    materialize_manifest(manifest, project_files)
}

fn materialize_manifest(
    manifest: WorkspaceBundleManifest,
    mut files: HashMap<String, Vec<u8>>,
) -> Result<ValidatedWorkspaceBundle, WorkspaceBundleError> {
    let entry_file_path = sanitize_project_path(&manifest.entry_file_path)
        .map_err(|_| WorkspaceBundleError::ManifestMismatch)?;
    if manifest.schema != SCHEMA
        || manifest.project_type != ProjectType::Typst
        || !ProjectType::Typst.accepts_entry_file_path(&entry_file_path)
        || manifest.files.is_empty()
        || manifest.files.len() > MAX_FILES
        || manifest.files.len() != files.len()
    {
        return Err(WorkspaceBundleError::ManifestMismatch);
    }
    let mut manifest_paths = HashSet::with_capacity(manifest.files.len());
    let mut documents = Vec::new();
    let mut assets = Vec::new();
    let mut directories = HashSet::new();
    let mut entry_is_document = false;
    for record in manifest.files {
        let path = sanitize_project_path(&record.path)
            .map_err(|_| WorkspaceBundleError::ManifestMismatch)?;
        if path != record.path
            || !manifest_paths.insert(path.clone())
            || record.size_bytes < 0
            || record.sha256.len() != 64
        {
            return Err(WorkspaceBundleError::ManifestMismatch);
        }
        let bytes = files
            .remove(&path)
            .ok_or(WorkspaceBundleError::ManifestMismatch)?;
        if i64::try_from(bytes.len()).ok() != Some(record.size_bytes)
            || hex::encode(Sha256::digest(&bytes)) != record.sha256
        {
            return Err(WorkspaceBundleError::ManifestMismatch);
        }
        collect_parent_directories(&path, &mut directories);
        match record.kind.as_str() {
            "document"
                if record.media_type.is_none()
                    && is_document_text_path(&path)
                    && std::str::from_utf8(&bytes).is_ok() =>
            {
                entry_is_document |= path == entry_file_path;
                let content =
                    String::from_utf8(bytes).map_err(|_| WorkspaceBundleError::ManifestMismatch)?;
                documents.push(WorkspaceDocument { path, content });
            }
            "asset" => {
                let media_type = record
                    .media_type
                    .filter(|value| {
                        value.len() <= 127
                            && value
                                .parse::<mime::Mime>()
                                .is_ok_and(|parsed| parsed.essence_str() == value)
                    })
                    .ok_or(WorkspaceBundleError::ManifestMismatch)?;
                assets.push(WorkspaceBundleAsset {
                    path,
                    media_type,
                    bytes,
                });
            }
            _ => return Err(WorkspaceBundleError::ManifestMismatch),
        }
    }
    if !files.is_empty()
        || !entry_is_document
        || manifest_paths.iter().any(|path| directories.contains(path))
    {
        return Err(WorkspaceBundleError::ManifestMismatch);
    }
    documents.sort_by(|left, right| left.path.cmp(&right.path));
    assets.sort_by(|left, right| left.path.cmp(&right.path));
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    Ok(ValidatedWorkspaceBundle {
        entry_file_path,
        directories,
        documents,
        assets,
    })
}

fn collect_parent_directories(path: &str, directories: &mut HashSet<String>) {
    let mut current = Path::new(path).parent();
    while let Some(parent) = current {
        let value = parent.to_string_lossy();
        if value.is_empty() {
            break;
        }
        directories.insert(value.replace('\\', "/"));
        current = parent.parent();
    }
}

fn safe_archive_name(name: &str) -> bool {
    name == "manifest.json"
        || name.strip_prefix("project/").is_some_and(|path| {
            !path.is_empty()
                && !path.contains('\\')
                && !path.chars().any(char::is_control)
                && sanitize_project_path(path).is_ok_and(|normalized| normalized == path)
        })
}

fn read_bounded(reader: &mut impl Read, limit: u64) -> Result<Vec<u8>, WorkspaceBundleError> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| WorkspaceBundleError::Archive)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(WorkspaceBundleError::Limit);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{validate_workspace_bundle, WorkspaceBundleError};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::Write as _;

    fn bundle_files(
        files: &[(&str, &str, &[u8])],
        entry: &str,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let manifest = serde_json::to_vec(&json!({
            "schema": "workspace-bundle/v1",
            "project_type": "typst",
            "entry_file_path": entry,
            "files": files.iter().map(|(path, kind, content)| json!({
                "path": path,
                "kind": kind,
                "size_bytes": content.len(),
                "sha256": hex::encode(Sha256::digest(content))
            })).collect::<Vec<_>>()
        }))?;
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        writer.start_file("manifest.json", options)?;
        writer.write_all(&manifest)?;
        for (path, _, content) in files {
            writer.start_file(format!("project/{path}"), options)?;
            writer.write_all(content)?;
        }
        Ok(writer.finish()?.into_inner())
    }

    fn bundle(kind: &str, entry: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        bundle_files(&[("main.typ", kind, b"= Imported slides")], entry)
    }

    #[test]
    fn materializes_a_typst_workspace() -> Result<(), Box<dyn std::error::Error>> {
        let workspace = validate_workspace_bundle(&bundle("document", "main.typ")?, 4096)?;
        assert_eq!(workspace.entry_file_path, "main.typ");
        assert_eq!(workspace.documents.len(), 1);
        assert!(workspace.assets.is_empty());
        Ok(())
    }

    #[test]
    fn entry_point_must_be_a_manifest_document() -> Result<(), Box<dyn std::error::Error>> {
        assert!(matches!(
            validate_workspace_bundle(&bundle("asset", "main.typ")?, 4096),
            Err(WorkspaceBundleError::ManifestMismatch)
        ));
        Ok(())
    }

    #[test]
    fn file_paths_cannot_also_be_directories() -> Result<(), Box<dyn std::error::Error>> {
        let content = bundle_files(
            &[
                ("main.typ", "document", b"= Imported slides"),
                ("main.typ/child.typ", "document", b"= Child"),
            ],
            "main.typ",
        )?;
        assert!(matches!(
            validate_workspace_bundle(&content, 4096),
            Err(WorkspaceBundleError::ManifestMismatch)
        ));
        Ok(())
    }
}
