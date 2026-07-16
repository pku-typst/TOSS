//! Built-in template catalog validation and asset loading.

use super::file_format::{LocalizedTextFile, TemplateGalleryFile};
use super::source_files::normalize_relative_path;
use super::{
    is_hex_color, resolve_path, validate_localized_text, validate_slug, LocalizedText,
    MAX_TEMPLATE_FILES, MAX_TEMPLATE_FILE_BYTES, MAX_TEMPLATE_THUMBNAIL_BYTES,
    MAX_TEMPLATE_TOTAL_BYTES,
};
use crate::workspace::{is_document_text_path, ProjectType};
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct BuiltinTemplateFile {
    pub path: String,
    pub bytes: std::sync::Arc<[u8]>,
    pub content_type: String,
    pub is_text: bool,
}

#[derive(Clone, Debug)]
pub struct BuiltinTemplateThumbnail {
    pub bytes: std::sync::Arc<[u8]>,
    pub content_type: String,
}

#[derive(Clone, Debug)]
pub struct BuiltinTemplate {
    pub id: String,
    pub name: LocalizedText,
    pub description: LocalizedText,
    pub category: String,
    pub tags: Vec<String>,
    pub project_type: ProjectType,
    pub entry_file_path: String,
    pub featured: bool,
    pub accent_color: String,
    pub files: Vec<BuiltinTemplateFile>,
    pub thumbnail: Option<BuiltinTemplateThumbnail>,
}

pub(super) fn load_builtin_templates(
    base_dir: &Path,
    gallery: TemplateGalleryFile,
    enabled_project_types: &[ProjectType],
    product_accent_color: &str,
) -> Result<Vec<BuiltinTemplate>, String> {
    if gallery.builtins.is_empty() {
        return Err("template_gallery.builtins must contain at least one template".to_string());
    }
    let mut seen_ids = HashSet::new();
    let mut templates = Vec::with_capacity(gallery.builtins.len());
    for configured in gallery.builtins {
        validate_slug(&configured.id, "template_gallery.builtins[].id")?;
        if !seen_ids.insert(configured.id.clone()) {
            return Err(format!(
                "template_gallery.builtins contains duplicate id '{}'",
                configured.id
            ));
        }
        let name = validate_localized_template_text(configured.name, "name", 80)?;
        let description =
            validate_localized_template_text(configured.description, "description", 320)?;
        validate_slug(&configured.category, "template_gallery.builtins[].category")?;
        if configured.tags.len() > 12 {
            return Err(format!(
                "template '{}' must not contain more than 12 tags",
                configured.id
            ));
        }
        for tag in &configured.tags {
            validate_slug(tag, "template_gallery.builtins[].tags[]")?;
        }
        let project_type = configured.project_type;
        if !enabled_project_types.contains(&project_type) {
            return Err(format!(
                "template '{}' uses disabled project type '{}'",
                configured.id, project_type
            ));
        }
        let entry_file_path = normalize_relative_path(&configured.entry_file)?;
        let source_dir = resolve_path(
            base_dir,
            &configured.source_dir,
            "template_gallery.builtins[].source_dir",
        )?;
        let files = load_template_directory(&source_dir)?;
        if !files
            .iter()
            .any(|file| file.path == entry_file_path && file.is_text)
        {
            return Err(format!(
                "template '{}' entry file '{}' is missing or is not text",
                configured.id, entry_file_path
            ));
        }
        let thumbnail = configured
            .thumbnail
            .as_deref()
            .map(|raw| load_template_thumbnail(base_dir, raw))
            .transpose()?;
        let accent_color = configured
            .accent_color
            .as_deref()
            .unwrap_or(product_accent_color)
            .trim()
            .to_ascii_lowercase();
        if !is_hex_color(&accent_color) {
            return Err(format!(
                "template '{}' accent_color must use #RRGGBB format",
                configured.id
            ));
        }
        templates.push(BuiltinTemplate {
            id: configured.id,
            name,
            description,
            category: configured.category,
            tags: configured.tags,
            project_type,
            entry_file_path,
            featured: configured.featured,
            accent_color,
            files,
            thumbnail,
        });
    }
    Ok(templates)
}

fn validate_localized_template_text(
    value: LocalizedTextFile,
    field: &str,
    max_chars: usize,
) -> Result<LocalizedText, String> {
    validate_localized_text(
        value,
        &format!("template_gallery.builtins[].{field}"),
        max_chars,
    )
}

fn load_template_directory(root: &Path) -> Result<Vec<BuiltinTemplateFile>, String> {
    let root_metadata = std::fs::symlink_metadata(root).map_err(|error| {
        format!(
            "failed to inspect built-in template directory {}: {error}",
            root.display()
        )
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(format!(
            "built-in template source must be a real directory: {}",
            root.display()
        ));
    }

    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|error| {
            format!(
                "failed to read built-in template directory {}: {error}",
                directory.display()
            )
        })?;
        for entry_result in entries {
            let entry = entry_result.map_err(|error| {
                format!("failed to read built-in template directory entry: {error}")
            })?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect built-in template file: {error}"))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "built-in template must not contain symlinks: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                return Err(format!(
                    "built-in template contains an unsupported filesystem entry: {}",
                    entry.path().display()
                ));
            }
            if files.len() >= MAX_TEMPLATE_FILES {
                return Err(format!(
                    "built-in template contains more than {MAX_TEMPLATE_FILES} files"
                ));
            }
            let metadata = entry
                .metadata()
                .map_err(|error| format!("failed to inspect built-in template file: {error}"))?;
            if metadata.len() > MAX_TEMPLATE_FILE_BYTES {
                return Err(format!(
                    "built-in template file is too large: {}",
                    entry.path().display()
                ));
            }
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "built-in template size overflow".to_string())?;
            if total_bytes > MAX_TEMPLATE_TOTAL_BYTES {
                return Err("built-in template exceeds the total size limit".to_string());
            }
            let entry_path = entry.path();
            let relative = entry_path.strip_prefix(root).map_err(|_| {
                "built-in template file escaped its configured directory".to_string()
            })?;
            let relative_text = relative
                .to_str()
                .ok_or_else(|| "built-in template path must be valid Unicode".to_string())?;
            let path = normalize_relative_path(relative_text)?;
            let bytes = std::fs::read(&entry_path).map_err(|error| {
                format!("failed to read built-in template file {path}: {error}")
            })?;
            let is_text = is_document_text_path(&path);
            if is_text && std::str::from_utf8(&bytes).is_err() {
                return Err(format!("built-in template text file is not UTF-8: {path}"));
            }
            let content_type = if is_text {
                "text/plain; charset=utf-8".to_string()
            } else {
                mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string()
            };
            files.push(BuiltinTemplateFile {
                path,
                bytes: std::sync::Arc::from(bytes.into_boxed_slice()),
                content_type,
                is_text,
            });
        }
    }
    if files.is_empty() {
        return Err(format!(
            "built-in template directory is empty: {}",
            root.display()
        ));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn load_template_thumbnail(base_dir: &Path, raw: &str) -> Result<BuiltinTemplateThumbnail, String> {
    let path = resolve_path(base_dir, raw, "template_gallery.builtins[].thumbnail")?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        format!(
            "failed to inspect built-in template thumbnail {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_TEMPLATE_THUMBNAIL_BYTES
    {
        return Err(format!(
            "built-in template thumbnail must be a regular image below {MAX_TEMPLATE_THUMBNAIL_BYTES} bytes: {}",
            path.display()
        ));
    }
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    if !matches!(
        content_type.essence_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml"
    ) {
        return Err("built-in template thumbnail must be PNG, JPEG, WebP, or SVG".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|error| {
        format!(
            "failed to read built-in template thumbnail {}: {error}",
            path.display()
        )
    })?;
    Ok(BuiltinTemplateThumbnail {
        bytes: std::sync::Arc::from(bytes.into_boxed_slice()),
        content_type: content_type.essence_str().to_string(),
    })
}
