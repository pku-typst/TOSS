//! Bounded structural validation for PPTX inputs and outputs.

use std::collections::HashSet;
use std::io::Cursor;
use thiserror::Error;

const MAX_ARCHIVE_ENTRIES: usize = 16_384;
const REQUIRED_PARTS: [&str; 3] = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"];

#[derive(Debug, Error)]
pub(super) enum PptxValidationError {
    #[error("PPTX is not a readable ZIP package")]
    Archive,
    #[error("PPTX contains an unsafe or duplicate part name")]
    UnsafePart,
    #[error("PPTX exceeds structural limits")]
    Limit,
    #[error("PPTX is missing a required presentation part")]
    MissingPart,
}

pub(super) fn validate_pptx(
    content: &[u8],
    max_expanded_bytes: u64,
) -> Result<(), PptxValidationError> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(content)).map_err(|_| PptxValidationError::Archive)?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(PptxValidationError::Limit);
    }
    let mut names = HashSet::with_capacity(archive.len());
    let mut required = HashSet::new();
    let mut expanded_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| PptxValidationError::Archive)?;
        let name = entry.name().to_string();
        let normalized = name.strip_suffix('/').unwrap_or(&name);
        if !safe_part_name(&name) || !names.insert(normalized.to_string()) {
            return Err(PptxValidationError::UnsafePart);
        }
        let mode = entry.unix_mode().unwrap_or(0o100644);
        let file_type = mode & 0o170000;
        if !matches!(file_type, 0 | 0o040000 | 0o100000) {
            return Err(PptxValidationError::UnsafePart);
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.size())
            .ok_or(PptxValidationError::Limit)?;
        if expanded_bytes > max_expanded_bytes {
            return Err(PptxValidationError::Limit);
        }
        if REQUIRED_PARTS.contains(&normalized) {
            if entry.is_dir() || entry.size() == 0 {
                return Err(PptxValidationError::MissingPart);
            }
            required.insert(normalized.to_string());
        }
        let actual_size = std::io::copy(&mut entry, &mut std::io::sink())
            .map_err(|_| PptxValidationError::Archive)?;
        if actual_size != entry.size() {
            return Err(PptxValidationError::Archive);
        }
    }
    if REQUIRED_PARTS.iter().any(|part| !required.contains(*part)) {
        return Err(PptxValidationError::MissingPart);
    }
    Ok(())
}

fn safe_part_name(name: &str) -> bool {
    let normalized = name.strip_suffix('/').unwrap_or(name);
    !normalized.is_empty()
        && normalized.len() <= 1024
        && !normalized.starts_with('/')
        && !normalized.contains(['\\', '\0', ':'])
        && !normalized.contains("//")
        && !normalized.chars().any(char::is_control)
        && normalized
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

#[cfg(test)]
mod tests {
    use super::{validate_pptx, PptxValidationError, REQUIRED_PARTS};
    use std::io::Write as _;

    fn package(extra: Option<&str>) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for path in REQUIRED_PARTS {
            writer.start_file(path, options)?;
            writer.write_all(b"<xml />")?;
        }
        if let Some(path) = extra {
            writer.start_file(path, options)?;
            writer.write_all(b"extra")?;
        }
        Ok(writer.finish()?.into_inner())
    }

    #[test]
    fn accepts_a_bounded_presentation_package() -> Result<(), Box<dyn std::error::Error>> {
        validate_pptx(&package(None)?, 1024)?;
        Ok(())
    }

    #[test]
    fn rejects_archive_paths_that_escape_the_package() -> Result<(), Box<dyn std::error::Error>> {
        assert!(matches!(
            validate_pptx(&package(Some("../escape"))?, 1024),
            Err(PptxValidationError::UnsafePart)
        ));
        Ok(())
    }

    #[test]
    fn enforces_the_expanded_size_limit() -> Result<(), Box<dyn std::error::Error>> {
        assert!(matches!(
            validate_pptx(&package(None)?, 4),
            Err(PptxValidationError::Limit)
        ));
        Ok(())
    }
}
