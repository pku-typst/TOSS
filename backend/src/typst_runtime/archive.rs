use super::{PackageLimits, PackageSpec};
use flate2::read::MultiGzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tar::Archive;
use thiserror::Error;

const MAX_TAR_OVERHEAD_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct PackageManifest {
    package: PackageManifestEntry,
}

#[derive(Debug, Deserialize)]
struct PackageManifestEntry {
    name: String,
    version: String,
}

struct LimitedReader<R> {
    inner: R,
    remaining: u64,
}

impl<R> LimitedReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            remaining: limit,
        }
    }
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            let mut probe = [0_u8; 1];
            if self.inner.read(&mut probe)? == 0 {
                return Ok(0);
            }
            return Err(std::io::Error::other(
                "Typst package decompressed stream exceeds the configured limit",
            ));
        }
        let requested = u64::try_from(buffer.len()).unwrap_or(u64::MAX);
        let allowed = usize::try_from(self.remaining.min(requested)).unwrap_or(buffer.len());
        let Some(slice) = buffer.get_mut(..allowed) else {
            return Err(std::io::Error::other(
                "Typst package decompression buffer is invalid",
            ));
        };
        let read = self.inner.read(slice)?;
        self.remaining = self
            .remaining
            .saturating_sub(u64::try_from(read).unwrap_or(u64::MAX));
        Ok(read)
    }
}

pub(super) fn archive_path_is_safe(path: &Path) -> bool {
    let mut saw_normal = false;
    for component in path.components() {
        match component {
            Component::Normal(value) if !value.is_empty() => saw_normal = true,
            Component::CurDir if !saw_normal => {}
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return false,
            Component::Normal(_) => return false,
        }
    }
    saw_normal
}

pub(super) fn validate_archive_contents(
    bytes: &[u8],
    spec: &PackageSpec,
    limits: PackageLimits,
) -> Result<(), ArchiveValidationError> {
    let max_tar_bytes = limits
        .max_extracted_bytes
        .saturating_add(MAX_TAR_OVERHEAD_BYTES);
    let decoder = MultiGzDecoder::new(bytes);
    let stream = LimitedReader::new(decoder, max_tar_bytes);
    let mut archive = Archive::new(stream);
    let entries = archive
        .entries()
        .map_err(ArchiveValidationError::ReadArchive)?;
    let mut entry_count = 0_u64;
    let mut extracted_bytes = 0_u64;
    let mut manifest = None;
    for entry_result in entries {
        let mut entry = entry_result.map_err(ArchiveValidationError::ReadEntry)?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or(ArchiveValidationError::EntryCountOverflow)?;
        if entry_count > limits.max_files {
            return Err(ArchiveValidationError::TooManyEntries {
                limit: limits.max_files,
            });
        }
        let path = entry
            .path()
            .map_err(ArchiveValidationError::ReadPath)?
            .into_owned();
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() && path == Path::new(".") {
            continue;
        }
        if !archive_path_is_safe(&path) {
            return Err(ArchiveValidationError::UnsafePath { path });
        }
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            return Err(ArchiveValidationError::UnsupportedEntry { path });
        }
        let size = entry.size();
        if size > limits.max_file_bytes {
            return Err(ArchiveValidationError::FileTooLarge {
                path,
                size,
                limit: limits.max_file_bytes,
            });
        }
        extracted_bytes = extracted_bytes
            .checked_add(size)
            .ok_or(ArchiveValidationError::ExtractedSizeOverflow)?;
        if extracted_bytes > limits.max_extracted_bytes {
            return Err(ArchiveValidationError::ExtractedSizeTooLarge {
                size: extracted_bytes,
                limit: limits.max_extracted_bytes,
            });
        }
        if path == Path::new("typst.toml") || path == Path::new("./typst.toml") {
            let mut value = String::new();
            entry
                .read_to_string(&mut value)
                .map_err(ArchiveValidationError::ReadManifest)?;
            manifest = Some(value);
        }
    }
    let mut remaining_stream = archive.into_inner();
    std::io::copy(&mut remaining_stream, &mut std::io::sink())
        .map_err(ArchiveValidationError::FinishArchive)?;
    let manifest = manifest.ok_or(ArchiveValidationError::MissingManifest)?;
    let parsed: PackageManifest =
        toml::from_str(&manifest).map_err(ArchiveValidationError::ParseManifest)?;
    if parsed.package.name != spec.name || parsed.package.version != spec.version {
        return Err(ArchiveValidationError::ManifestMismatch {
            requested_name: spec.name.clone(),
            requested_version: spec.version.clone(),
            manifest_name: parsed.package.name,
            manifest_version: parsed.package.version,
        });
    }
    Ok(())
}

#[derive(Debug, Error)]
pub(super) enum ArchiveValidationError {
    #[error("could not read tar archive")]
    ReadArchive(#[source] std::io::Error),
    #[error("could not read tar entry")]
    ReadEntry(#[source] std::io::Error),
    #[error("package entry count overflowed")]
    EntryCountOverflow,
    #[error("package contains more than {limit} entries")]
    TooManyEntries { limit: u64 },
    #[error("could not read archive path")]
    ReadPath(#[source] std::io::Error),
    #[error("package contains unsafe path {path}", path = path.display())]
    UnsafePath { path: PathBuf },
    #[error("package contains unsupported entry {path}", path = path.display())]
    UnsupportedEntry { path: PathBuf },
    #[error("package file {path} is {size} bytes, exceeding the {limit}-byte limit", path = path.display())]
    FileTooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
    #[error("package extracted size overflowed")]
    ExtractedSizeOverflow,
    #[error("package extracts to {size} bytes, exceeding the {limit}-byte limit")]
    ExtractedSizeTooLarge { size: u64, limit: u64 },
    #[error("could not read typst.toml")]
    ReadManifest(#[source] std::io::Error),
    #[error("could not finish reading compressed package stream")]
    FinishArchive(#[source] std::io::Error),
    #[error("package is missing typst.toml")]
    MissingManifest,
    #[error("could not parse typst.toml")]
    ParseManifest(#[source] toml::de::Error),
    #[error(
        "package manifest {manifest_name}@{manifest_version} does not match requested {requested_name}@{requested_version}"
    )]
    ManifestMismatch {
        requested_name: String,
        requested_version: String,
        manifest_name: String,
        manifest_version: String,
    },
}

pub(super) async fn validate_package_bytes(
    bytes: Vec<u8>,
    spec: PackageSpec,
    limits: PackageLimits,
) -> Result<(Vec<u8>, String), PackageValidationError> {
    let byte_len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if byte_len == 0 || byte_len > limits.max_archive_bytes {
        return Err(PackageValidationError::ArchiveSize {
            size: byte_len,
            limit: limits.max_archive_bytes,
        });
    }
    tokio::task::spawn_blocking(move || {
        validate_archive_contents(&bytes, &spec, limits).map_err(|source| {
            PackageValidationError::InvalidArchive {
                package: spec.key(),
                source,
            }
        })?;
        let sha256 = hex::encode(Sha256::digest(&bytes));
        Ok((bytes, sha256))
    })
    .await
    .map_err(|source| PackageValidationError::Worker { source })?
}

#[derive(Debug, Error)]
pub(super) enum PackageValidationError {
    #[error("Typst package archive is {size} bytes; expected 1 to {limit} bytes")]
    ArchiveSize { size: u64, limit: u64 },
    #[error("Typst package archive for {package} is invalid")]
    InvalidArchive {
        package: String,
        #[source]
        source: ArchiveValidationError,
    },
    #[error("Typst package validation worker failed")]
    Worker {
        #[source]
        source: tokio::task::JoinError,
    },
}
