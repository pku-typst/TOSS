//! Path containment and bounded-file policy for distribution-owned sources.

use std::path::{Path, PathBuf};

pub(super) fn resolve_distribution_file(
    base_dir: &Path,
    raw: &str,
    field: &str,
    max_bytes: u64,
) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(raw)
        .map_err(|_| format!("{field} must be a safe relative path"))?;
    let path = base_dir.join(normalized);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect {field} {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err(format!(
            "{field} must be a regular file no larger than {max_bytes} bytes: {}",
            path.display()
        ));
    }
    Ok(path)
}

pub(super) fn normalize_relative_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.len() > 1024
        || trimmed.contains('\\')
    {
        return Err("distribution file path is invalid".to_string());
    }
    let path = Path::new(trimmed);
    let mut parts = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(value) = component else {
            return Err("distribution file path is invalid".to_string());
        };
        let part = value
            .to_str()
            .ok_or_else(|| "distribution file path must be valid Unicode".to_string())?;
        if part.is_empty() || part.len() > 255 || part.chars().any(char::is_control) {
            return Err("distribution file path is invalid".to_string());
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Err("distribution file path is invalid".to_string());
    }
    Ok(parts.join("/"))
}

pub(super) fn resolve_path(base_dir: &Path, raw: &str, field: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let path = PathBuf::from(trimmed);
    Ok(if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    })
}

pub(super) fn read_template(path: &Path, label: &str) -> Result<String, String> {
    let content = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read {label} starter template {}: {error}",
            path.display()
        )
    })?;
    if content.trim().is_empty() {
        return Err(format!("{label} starter template must not be empty"));
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::normalize_relative_path;
    use std::error::Error;

    #[test]
    fn distribution_paths_are_relative_and_normalized() -> Result<(), Box<dyn Error>> {
        assert_eq!(
            normalize_relative_path("figures/result.svg")?,
            "figures/result.svg"
        );
        for unsafe_path in [
            "/main.typ",
            "../main.typ",
            "figures/../main.typ",
            "figures\\main.typ",
        ] {
            assert!(normalize_relative_path(unsafe_path).is_err());
        }
        Ok(())
    }
}
