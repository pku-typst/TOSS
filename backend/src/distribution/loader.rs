//! Distribution-file selection, validation, and runtime assembly.

use super::experience_content::load_experience;
use super::file_format::DistributionFile;
use super::template_catalog::load_builtin_templates;
use super::{
    is_hex_color, read_template, resolve_distribution_file, resolve_path, validate_localized_text,
    CapabilitiesConfig, CheckpointBranchPrefix, DistributionConfig, GitConfig, ProductAsset,
    ProductConfig, CONFIG_SCHEMA_VERSION, MAX_PRODUCT_ASSET_BYTES,
};
use crate::workspace::ProjectType;
use std::env;
use std::path::Path;

impl DistributionConfig {
    pub fn load_from_env() -> Result<Self, String> {
        match env::var("TOSS_CONFIG") {
            Ok(raw_path) => {
                let trimmed = raw_path.trim();
                if trimmed.is_empty() {
                    return Err("TOSS_CONFIG must not be empty".to_string());
                }
                Self::load(Path::new(trimmed))
            }
            Err(env::VarError::NotPresent) => {
                for candidate in [
                    Path::new("./distributions/community/toss.json"),
                    Path::new("../distributions/community/toss.json"),
                ] {
                    if candidate.is_file() {
                        return Self::load(candidate);
                    }
                }
                Ok(Self::default())
            }
            Err(env::VarError::NotUnicode(_)) => {
                Err("TOSS_CONFIG must be valid Unicode".to_string())
            }
        }
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|error| {
            format!(
                "failed to read distribution config {}: {error}",
                path.display()
            )
        })?;
        let file: DistributionFile = serde_json::from_str(&raw)
            .map_err(|error| format!("invalid distribution config {}: {error}", path.display()))?;
        if file.schema != CONFIG_SCHEMA_VERSION {
            return Err(format!(
                "unsupported distribution config schema {}; expected {CONFIG_SCHEMA_VERSION}",
                file.schema
            ));
        }
        validate_id(&file.id)?;
        let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
        let name = file.product.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err("product.name must contain between 1 and 80 characters".to_string());
        }
        let product_description =
            validate_localized_text(file.product.description, "product.description", 240)?;
        let brand_mark = file.product.brand_mark.trim().to_string();
        if brand_mark.is_empty()
            || brand_mark.chars().count() > 8
            || brand_mark.chars().any(char::is_control)
        {
            return Err(
                "product.brand_mark must contain between 1 and 8 printable characters".to_string(),
            );
        }
        let accent_color = file.product.accent_color.trim().to_ascii_lowercase();
        if !is_hex_color(&accent_color) {
            return Err("product.accent_color must use #RRGGBB format".to_string());
        }
        let accent_text_color = file.product.accent_text_color.trim().to_ascii_lowercase();
        if !is_hex_color(&accent_text_color) {
            return Err("product.accent_text_color must use #RRGGBB format".to_string());
        }
        let favicon = load_product_asset(base_dir, &file.product.favicon, "product.favicon")?;
        let touch_icon = file
            .product
            .touch_icon
            .as_deref()
            .map(|raw| load_product_asset(base_dir, raw, "product.touch_icon"))
            .transpose()?;
        let checkpoint_branch_prefix =
            CheckpointBranchPrefix::parse(&file.git.checkpoint_branch_prefix).map_err(|_| {
                "git.checkpoint_branch_prefix must be a lowercase Git path ending in '/'"
                    .to_string()
            })?;
        let fallback_owner_name = file.git.fallback_owner_name.trim().to_string();
        if fallback_owner_name.is_empty()
            || fallback_owner_name.chars().count() > 100
            || fallback_owner_name
                .bytes()
                .any(|byte| byte.is_ascii_control() || matches!(byte, b'<' | b'>'))
        {
            return Err(
                "git.fallback_owner_name must contain between 1 and 100 safe characters"
                    .to_string(),
            );
        }
        let fallback_email_domain = file.git.fallback_email_domain.trim().to_ascii_lowercase();
        validate_email_domain(&fallback_email_domain)?;
        let project_types = validate_project_types(file.capabilities.project_types)?;
        let latex_enabled = project_types.contains(&ProjectType::Latex);

        let builtin_dir = resolve_path(base_dir, &file.typst.builtin_dir, "typst.builtin_dir")?;
        let catalog_path = builtin_dir.join("catalog.json");
        if !catalog_path.is_file() {
            return Err(format!(
                "Typst catalog does not exist: {}",
                catalog_path.display()
            ));
        }
        let typst_template_path = resolve_path(
            base_dir,
            &file.typst.starter_templates.typst,
            "typst.starter_templates.typst",
        )?;
        let typst_template = read_template(&typst_template_path, "Typst")?;
        let latex_template = match (latex_enabled, file.typst.starter_templates.latex.as_deref()) {
            (true, Some(configured_path)) => {
                let template_path =
                    resolve_path(base_dir, configured_path, "typst.starter_templates.latex")?;
                Some(read_template(&template_path, "LaTeX")?)
            }
            (true, None) => {
                return Err(
                    "typst.starter_templates.latex is required when LaTeX is enabled".to_string(),
                );
            }
            (false, Some(_)) => {
                return Err(
                    "typst.starter_templates.latex must be omitted when LaTeX is disabled"
                        .to_string(),
                );
            }
            (false, None) => None,
        };
        let builtin_templates = load_builtin_templates(
            base_dir,
            file.template_gallery,
            &project_types,
            &accent_color,
        )?;
        let experience = load_experience(base_dir, file.experience)?;

        Ok(Self {
            id: file.id,
            product: ProductConfig {
                name,
                description: product_description,
                name_managed: file.product.name_managed,
                brand_mark,
                accent_color,
                accent_text_color,
                favicon,
                touch_icon,
                indexing: file.product.indexing,
            },
            git: GitConfig {
                checkpoint_branch_prefix,
                fallback_owner_name,
                fallback_email_domain,
            },
            capabilities: CapabilitiesConfig { project_types },
            experience,
            typst_builtin_dir: Some(builtin_dir),
            builtin_templates,
            typst_template,
            latex_template,
            source_path: Some(path.to_path_buf()),
        })
    }
}

fn load_product_asset(base_dir: &Path, raw: &str, field: &str) -> Result<ProductAsset, String> {
    let path = resolve_distribution_file(base_dir, raw, field, MAX_PRODUCT_ASSET_BYTES)?;
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    if !matches!(
        content_type.essence_str(),
        "image/svg+xml" | "image/png" | "image/x-icon"
    ) {
        return Err(format!("{field} must be an SVG, PNG, or ICO image"));
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("failed to read {field} {}: {error}", path.display()))?;
    if content_type.essence_str() == "image/svg+xml" {
        let svg = std::str::from_utf8(&bytes)
            .map_err(|_| format!("{field} SVG must be valid UTF-8"))?
            .to_ascii_lowercase();
        if ["<script", "javascript:", "<foreignobject", "onload="]
            .iter()
            .any(|needle| svg.contains(needle))
        {
            return Err(format!("{field} SVG contains unsafe active content"));
        }
    }
    Ok(ProductAsset {
        bytes: std::sync::Arc::from(bytes.into_boxed_slice()),
        content_type: content_type.essence_str().to_string(),
    })
}

fn validate_project_types(values: Vec<ProjectType>) -> Result<Vec<ProjectType>, String> {
    let mut typst_enabled = false;
    let mut latex_enabled = false;
    for value in values {
        match value {
            ProjectType::Typst if !typst_enabled => typst_enabled = true,
            ProjectType::Latex if !latex_enabled => latex_enabled = true,
            ProjectType::Typst | ProjectType::Latex => {
                return Err("capabilities.project_types must not contain duplicates".to_string());
            }
        }
    }
    if !typst_enabled {
        return Err("capabilities.project_types must include 'typst'".to_string());
    }
    let mut normalized = vec![ProjectType::Typst];
    if latex_enabled {
        normalized.push(ProjectType::Latex);
    }
    Ok(normalized)
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 48
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(
            "distribution id must contain only lowercase ASCII letters, digits, and hyphens"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_email_domain(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 253
        || value.starts_with(['.', '-'])
        || value.ends_with(['.', '-'])
        || value.contains("..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
    {
        return Err("git.fallback_email_domain must be a lowercase DNS-style domain".to_string());
    }
    Ok(())
}
