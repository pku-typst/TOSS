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
pub struct ProjectBundleManifest {
    pub schema: String,
    pub project_type: String,
    pub entry_file_path: String,
    pub latex_engine: Option<String>,
    pub workspace_version: i64,
    pub content_generation: i64,
    pub source_epoch: i64,
    pub files: Vec<ProjectBundleFile>,
    #[serde(default)]
    pub packages: Vec<ProjectBundlePackage>,
}

#[derive(Clone, Deserialize)]
pub struct ProjectBundleFile {
    pub path: String,
    pub kind: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Clone, Deserialize)]
pub struct ProjectBundlePackage {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub archive_sha256: String,
    pub files: Vec<ProjectBundlePackageFile>,
}

#[derive(Clone, Deserialize)]
pub struct ProjectBundlePackageFile {
    pub path: String,
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
    pub packages_dir: PathBuf,
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
    let packages_dir = root.path().join("packages");
    fs::create_dir(&project_dir).map_err(InputError::Io)?;
    fs::create_dir(&packages_dir).map_err(InputError::Io)?;
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
        let (materialization_root, relative, package_file) =
            if let Some(relative) = name.strip_prefix("project/") {
                (&project_dir, relative, false)
            } else if let Some(relative) = name.strip_prefix("packages/") {
                (&packages_dir, relative, true)
            } else {
                return Err(InputError::UnsafePath);
            };
        if relative.is_empty() {
            continue;
        }
        let relative_path = Path::new(relative);
        let destination = materialization_root.join(relative_path);
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
        materialized_files.insert(if package_file {
            format!("packages/{relative}")
        } else {
            format!("project/{relative}")
        });
    }

    let manifest: ProjectBundleManifest =
        serde_json::from_slice(manifest_bytes.as_deref().ok_or(InputError::Manifest)?)
            .map_err(|_| InputError::Manifest)?;
    validate_manifest(
        &manifest,
        input_schema,
        &project_dir,
        &packages_dir,
        &materialized_files,
    )?;
    Ok(ProjectInput {
        _root: root,
        project_dir,
        packages_dir,
        manifest,
    })
}

fn validate_manifest(
    manifest: &ProjectBundleManifest,
    input_schema: &str,
    project_dir: &Path,
    packages_dir: &Path,
    materialized_files: &HashSet<String>,
) -> Result<(), InputError> {
    let package_file_count = manifest
        .packages
        .iter()
        .try_fold(0_usize, |total, package| {
            total.checked_add(package.files.len())
        })
        .ok_or(InputError::ManifestMismatch)?;
    if manifest.schema != input_schema
        || !matches!(
            manifest.schema.as_str(),
            "project-bundle/v1" | "typst-project-bundle/v1"
        )
        || (manifest.schema == "project-bundle/v1" && !manifest.packages.is_empty())
        || manifest
            .files
            .len()
            .checked_add(package_file_count)
            .is_none_or(|count| count != materialized_files.len())
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
    validate_packages(&manifest.packages, packages_dir, materialized_files)?;
    let entry_is_document = manifest
        .files
        .iter()
        .any(|record| record.path == manifest.entry_file_path && record.kind == "document");
    let expected_paths = paths
        .into_iter()
        .map(|path| format!("project/{path}"))
        .chain(manifest.packages.iter().flat_map(|package| {
            package.files.iter().map(|file| {
                format!(
                    "packages/{}/{}/{}/{}",
                    package.namespace, package.name, package.version, file.path
                )
            })
        }))
        .collect::<HashSet<_>>();
    if expected_paths != *materialized_files
        || !entry_is_document
        || !project_dir.join(&manifest.entry_file_path).is_file()
    {
        return Err(InputError::ManifestMismatch);
    }
    Ok(())
}

fn validate_packages(
    packages: &[ProjectBundlePackage],
    packages_dir: &Path,
    materialized_files: &HashSet<String>,
) -> Result<(), InputError> {
    let mut identities = HashSet::new();
    for package in packages {
        let identity = format!("{}/{}/{}", package.namespace, package.name, package.version);
        if !matches!(package.namespace.as_str(), "local" | "preview")
            || !safe_segment(&package.name)
            || !safe_version(&package.version)
            || package.archive_sha256.len() != 64
            || !package
                .archive_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !identities.insert(identity.clone())
        {
            return Err(InputError::ManifestMismatch);
        }
        let mut package_paths = HashSet::new();
        for file in &package.files {
            let materialized = format!("packages/{identity}/{}", file.path);
            if !safe_relative_path(&file.path)
                || !package_paths.insert(file.path.clone())
                || !materialized_files.contains(&materialized)
                || file.size_bytes < 0
                || file.sha256.len() != 64
            {
                return Err(InputError::ManifestMismatch);
            }
            let bytes =
                fs::read(packages_dir.join(&identity).join(&file.path)).map_err(InputError::Io)?;
            if i64::try_from(bytes.len()).ok() != Some(file.size_bytes)
                || hex::encode(Sha256::digest(&bytes)) != file.sha256
            {
                return Err(InputError::ManifestMismatch);
            }
        }
        if package_paths.is_empty() {
            return Err(InputError::ManifestMismatch);
        }
    }
    Ok(())
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

fn safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
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
        kind: &str,
        source_epoch: i64,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let source = b"Hello from LaTeX";
        let manifest = serde_json::to_vec(&json!({
            "schema": "project-bundle/v1",
            "project_type": "latex",
            "entry_file_path": "main.tex",
            "latex_engine": "pdftex",
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

    fn claim_for(content: &[u8]) -> WorkerClaimInput {
        WorkerClaimInput {
            schema: "project-bundle/v1".to_string(),
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
        let bundle = project_bundle("document", 1_700_000_000)?;
        let ProcessorInput::Project(verified) = verify_input(&bundle, &claim_for(&bundle))? else {
            return Err("project bundle was materialized as a binary input".into());
        };
        assert_eq!(verified.manifest.content_generation, 3);
        assert_eq!(
            std::fs::read(verified.project_dir.join("main.tex"))?,
            b"Hello from LaTeX"
        );
        assert!(verified.packages_dir.is_dir());
        Ok(())
    }

    #[test]
    fn rejects_unknown_file_kinds_and_invalid_source_epochs(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let unknown_kind = project_bundle("executable", 1_700_000_000)?;
        assert!(matches!(
            verify_input(&unknown_kind, &claim_for(&unknown_kind)),
            Err(InputError::ManifestMismatch)
        ));
        let negative_epoch = project_bundle("document", -1)?;
        assert!(matches!(
            verify_input(&negative_epoch, &claim_for(&negative_epoch)),
            Err(InputError::ManifestMismatch)
        ));
        Ok(())
    }
}
