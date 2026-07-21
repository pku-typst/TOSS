//! Digest verification and defensive materialization of typed processing inputs.

use crate::protocol::WorkerClaimInput;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use thiserror::Error;

const MAX_BUNDLE_FILES: usize = 4096;
const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SOURCE_EPOCH: i64 = 253_402_300_799;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectBundleManifest {
    pub schema: String,
    pub project_type: String,
    pub entry_file_path: String,
    pub latex_engine: Option<String>,
    pub workspace_version: i64,
    pub content_generation: i64,
    pub source_epoch: i64,
    pub files: Vec<ProjectBundleFile>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectBundleFile {
    pub path: String,
    pub kind: String,
    pub size_bytes: i64,
    pub sha256: String,
}

pub enum ProcessorInput {
    Project(ProjectInput),
    Binary(BinaryInput),
}

pub struct ProjectInput {
    _root: TempDir,
    pub project_dir: PathBuf,
    pub manifest: ProjectBundleManifest,
}

pub struct BinaryInput {
    pub schema: String,
    pub content: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum InputError {
    #[error("input byte count does not match the claim")]
    SizeMismatch,
    #[error("input digest does not match the claim")]
    DigestMismatch,
    #[error("input schema is unsupported")]
    Schema,
    #[error("input archive is invalid")]
    Archive,
    #[error("input archive path is unsafe")]
    UnsafePath,
    #[error("input archive contains an unsupported file type")]
    UnsupportedFileType,
    #[error("input archive exceeds extraction limits")]
    Limit,
    #[error("input manifest is invalid")]
    Manifest,
    #[error("input archive does not match its manifest")]
    ManifestMismatch,
    #[error("input materialization failed")]
    Io(#[source] std::io::Error),
}

pub fn verify_input(
    content: &[u8],
    input: &WorkerClaimInput,
) -> Result<ProcessorInput, InputError> {
    if i64::try_from(content.len()).ok() != Some(input.size_bytes) {
        return Err(InputError::SizeMismatch);
    }
    let expected = hex::decode(&input.sha256).map_err(|_| InputError::DigestMismatch)?;
    if expected.as_slice() != Sha256::digest(content).as_slice() {
        return Err(InputError::DigestMismatch);
    }
    match input.schema.as_str() {
        "project-bundle/v1" | "typst-project-bundle/v1" => {
            verify_and_extract_project(content, &input.schema).map(ProcessorInput::Project)
        }
        "pptx-input/v1" => Ok(ProcessorInput::Binary(BinaryInput {
            schema: input.schema.clone(),
            content: content.to_vec(),
        })),
        _ => Err(InputError::Schema),
    }
}

fn verify_and_extract_project(
    content: &[u8],
    input_schema: &str,
) -> Result<ProjectInput, InputError> {
    let root = tempfile::tempdir().map_err(InputError::Io)?;
    let project_dir = root.path().join("project");
    fs::create_dir(&project_dir).map_err(InputError::Io)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(content)).map_err(|_| InputError::Archive)?;
    if archive.is_empty() || archive.len() > MAX_BUNDLE_FILES + 1 {
        return Err(InputError::Limit);
    }
    let mut names = HashSet::new();
    let mut declared_expanded = 0_u64;
    let mut actual_expanded = 0_u64;
    let mut manifest_bytes = None;
    let mut materialized_files = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| InputError::Archive)?;
        let name = entry.name().to_string();
        let normalized_name = name.strip_suffix('/').unwrap_or(&name);
        if !safe_archive_name(&name) || !names.insert(normalized_name.to_string()) {
            return Err(InputError::UnsafePath);
        }
        let mode = entry.unix_mode().unwrap_or(0o100644);
        let file_type = mode & 0o170000;
        if !matches!(file_type, 0 | 0o040000 | 0o100000) {
            return Err(InputError::UnsupportedFileType);
        }
        declared_expanded = declared_expanded
            .checked_add(entry.size())
            .ok_or(InputError::Limit)?;
        if declared_expanded > MAX_EXPANDED_BYTES {
            return Err(InputError::Limit);
        }
        if name == "manifest.json" {
            if entry.is_dir() || entry.size() > MAX_MANIFEST_BYTES {
                return Err(InputError::Manifest);
            }
            let remaining = MAX_EXPANDED_BYTES.saturating_sub(actual_expanded);
            let bytes = read_bounded(&mut entry, remaining.min(MAX_MANIFEST_BYTES))?;
            actual_expanded = actual_expanded
                .checked_add(u64::try_from(bytes.len()).map_err(|_| InputError::Limit)?)
                .ok_or(InputError::Limit)?;
            manifest_bytes = Some(bytes);
            continue;
        }
        let relative = name
            .strip_prefix("project/")
            .ok_or(InputError::UnsafePath)?;
        if relative.is_empty() {
            continue;
        }
        let relative_path = Path::new(relative);
        let destination = project_dir.join(relative_path);
        if entry.is_dir() {
            if entry.size() != 0 {
                return Err(InputError::Archive);
            }
            fs::create_dir_all(&destination).map_err(InputError::Io)?;
            continue;
        }
        let parent = destination.parent().ok_or(InputError::UnsafePath)?;
        fs::create_dir_all(parent).map_err(InputError::Io)?;
        let mut output = File::create(&destination).map_err(InputError::Io)?;
        let written = copy_bounded(
            &mut entry,
            &mut output,
            MAX_EXPANDED_BYTES.saturating_sub(actual_expanded),
        )?;
        actual_expanded = actual_expanded
            .checked_add(written)
            .ok_or(InputError::Limit)?;
        materialized_files.insert(format!("project/{relative}"));
    }

    let manifest: ProjectBundleManifest =
        serde_json::from_slice(manifest_bytes.as_deref().ok_or(InputError::Manifest)?)
            .map_err(|_| InputError::Manifest)?;
    validate_manifest(&manifest, input_schema, &project_dir, &materialized_files)?;
    Ok(ProjectInput {
        _root: root,
        project_dir,
        manifest,
    })
}

fn validate_manifest(
    manifest: &ProjectBundleManifest,
    input_schema: &str,
    project_dir: &Path,
    materialized_files: &HashSet<String>,
) -> Result<(), InputError> {
    if manifest.schema != input_schema
        || !matches!(
            manifest.schema.as_str(),
            "project-bundle/v1" | "typst-project-bundle/v1"
        )
        || manifest.files.len() != materialized_files.len()
        || !safe_relative_path(&manifest.entry_file_path)
        || manifest.workspace_version < 0
        || manifest.content_generation < 0
        || !(0..=MAX_SOURCE_EPOCH).contains(&manifest.source_epoch)
    {
        return Err(InputError::ManifestMismatch);
    }
    let mut paths = HashSet::new();
    for record in &manifest.files {
        if !safe_relative_path(&record.path)
            || !paths.insert(record.path.clone())
            || !materialized_files.contains(&format!("project/{}", record.path))
            || !matches!(record.kind.as_str(), "document" | "asset")
            || record.size_bytes < 0
            || record.sha256.len() != 64
        {
            return Err(InputError::ManifestMismatch);
        }
        let bytes = fs::read(project_dir.join(&record.path)).map_err(InputError::Io)?;
        if i64::try_from(bytes.len()).ok() != Some(record.size_bytes)
            || hex::encode(Sha256::digest(&bytes)) != record.sha256
        {
            return Err(InputError::ManifestMismatch);
        }
    }
    let entry_is_document = manifest
        .files
        .iter()
        .any(|record| record.path == manifest.entry_file_path && record.kind == "document");
    let expected_paths = paths
        .into_iter()
        .map(|path| format!("project/{path}"))
        .collect::<HashSet<_>>();
    if expected_paths != *materialized_files
        || !entry_is_document
        || !project_dir.join(&manifest.entry_file_path).is_file()
    {
        return Err(InputError::ManifestMismatch);
    }
    Ok(())
}

fn safe_archive_name(name: &str) -> bool {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains("//")
    {
        return false;
    }
    let normalized = name.strip_suffix('/').unwrap_or(name);
    safe_relative_path(normalized)
}

pub fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn read_bounded(reader: &mut impl Read, limit: u64) -> Result<Vec<u8>, InputError> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(InputError::Io)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
        return Err(InputError::Limit);
    }
    Ok(bytes)
}

fn copy_bounded(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
) -> Result<u64, InputError> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).map_err(InputError::Io)?;
        if read == 0 {
            return Ok(copied);
        }
        copied = copied
            .checked_add(u64::try_from(read).map_err(|_| InputError::Limit)?)
            .ok_or(InputError::Limit)?;
        if copied > limit {
            return Err(InputError::Limit);
        }
        let chunk = buffer.get(..read).ok_or(InputError::Archive)?;
        writer.write_all(chunk).map_err(InputError::Io)?;
    }
}

#[cfg(test)]
mod tests {
    use super::{safe_archive_name, safe_relative_path, verify_input, InputError, ProcessorInput};
    use crate::protocol::WorkerClaimInput;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::Write as _;

    fn project_bundle(
        schema: &str,
        project_type: &str,
        kind: &str,
        source_epoch: i64,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let source = b"Hello from LaTeX";
        let manifest = serde_json::to_vec(&json!({
            "schema": schema,
            "project_type": project_type,
            "entry_file_path": "main.tex",
            "latex_engine": (project_type == "latex").then_some("pdftex"),
            "workspace_version": 7,
            "content_generation": 3,
            "source_epoch": source_epoch,
            "files": [{
                "path": "main.tex",
                "kind": kind,
                "size_bytes": source.len(),
                "sha256": hex::encode(Sha256::digest(source))
            }]
        }))?;
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        writer.start_file("manifest.json", options)?;
        writer.write_all(&manifest)?;
        writer.start_file("project/main.tex", options)?;
        writer.write_all(source)?;
        Ok(writer.finish()?.into_inner())
    }

    fn claim_for(content: &[u8], schema: &str) -> WorkerClaimInput {
        WorkerClaimInput {
            schema: schema.to_string(),
            size_bytes: i64::try_from(content.len()).unwrap_or(i64::MAX),
            sha256: hex::encode(Sha256::digest(content)),
            download_url: "/unused".to_string(),
            download_token: "unused".to_string(),
        }
    }

    #[test]
    fn rejects_paths_that_escape_the_materialization_root() {
        assert!(safe_relative_path("chapters/intro.tex"));
        assert!(!safe_relative_path("../secret"));
        assert!(!safe_relative_path("/etc/passwd"));
        assert!(!safe_relative_path("chapters\\intro.tex"));
        assert!(!safe_relative_path("chapters/intro\n.tex"));
        assert!(!safe_archive_name("project/../secret"));
        assert!(!safe_archive_name("project//intro.tex"));
        assert!(!safe_archive_name("project/./intro.tex"));
        assert!(safe_archive_name("project/chapters/"));
    }

    #[test]
    fn verifies_the_core_project_bundle_shape() -> Result<(), Box<dyn std::error::Error>> {
        let schema = "project-bundle/v1";
        let bundle = project_bundle(schema, "latex", "document", 1_700_000_000)?;
        let ProcessorInput::Project(verified) = verify_input(&bundle, &claim_for(&bundle, schema))?
        else {
            return Err("project bundle was materialized as a binary input".into());
        };
        assert_eq!(verified.manifest.content_generation, 3);
        assert_eq!(
            std::fs::read(verified.project_dir.join("main.tex"))?,
            b"Hello from LaTeX"
        );
        Ok(())
    }

    #[test]
    fn verifies_typst_bundles_without_runtime_packages() -> Result<(), Box<dyn std::error::Error>> {
        let schema = "typst-project-bundle/v1";
        let bundle = project_bundle(schema, "typst", "document", 1_700_000_000)?;
        let ProcessorInput::Project(verified) = verify_input(&bundle, &claim_for(&bundle, schema))?
        else {
            return Err("Typst bundle was materialized as a binary input".into());
        };
        assert_eq!(verified.manifest.project_type, "typst");
        assert!(verified.project_dir.join("main.tex").is_file());
        Ok(())
    }

    #[test]
    fn rejects_unknown_file_kinds_and_invalid_source_epochs(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let schema = "project-bundle/v1";
        let unknown_kind = project_bundle(schema, "latex", "executable", 1_700_000_000)?;
        assert!(matches!(
            verify_input(&unknown_kind, &claim_for(&unknown_kind, schema)),
            Err(InputError::ManifestMismatch)
        ));
        let negative_epoch = project_bundle(schema, "latex", "document", -1)?;
        assert!(matches!(
            verify_input(&negative_epoch, &claim_for(&negative_epoch, schema)),
            Err(InputError::ManifestMismatch)
        ));
        Ok(())
    }
}
