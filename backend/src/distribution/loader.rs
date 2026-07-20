//! Distribution-file selection, validation, and runtime assembly.

use super::ai_assistant::load_ai_assistant;
use super::experience_content::load_experience;
use super::file_format::{DistributionFile, ProcessingOperationPolicyFile};
use super::template_catalog::load_builtin_templates;
use super::{
    is_hex_color, read_template, resolve_distribution_file, resolve_path, validate_localized_text,
    CheckpointBranchPrefix, DistributionConfig, DocumentProcessingDistributionConfig,
    FrontendFeature, FrontendFeaturesConfig, GitConfig, ProcessingOperationPolicy, ProductAsset,
    ProductConfig, CONFIG_SCHEMA_VERSION, MAX_PRODUCT_ASSET_BYTES,
};
use crate::document_processing::ProcessingOperation;
use crate::typst_runtime::TypstPackageRequirement;
use crate::workspace::ProjectType;
use std::collections::HashSet;
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
        let project_types = if file.project_types.latex.is_some() {
            vec![ProjectType::Typst, ProjectType::Latex]
        } else {
            vec![ProjectType::Typst]
        };
        let frontend_features = validate_frontend_features(
            file.frontend_features.included,
            file.frontend_features.default_enabled,
        )?;
        let ai_assistant = load_ai_assistant(
            file.ai_assistant,
            frontend_features
                .included
                .contains(&FrontendFeature::AiAssistant),
        )?;
        let processing_operations = validate_processing_operations(
            file.document_processing.allowed_operations,
            &project_types,
        )?;
        let processing_operation_policies = validate_processing_operation_policies(
            file.document_processing.operation_policies,
            &processing_operations,
        )?;

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
            &file.project_types.typst.starter_template,
            "project_types.typst.starter_template",
        )?;
        let typst_template = read_template(&typst_template_path, "Typst")?;
        let latex_template = match file.project_types.latex {
            Some(configured) => {
                let template_path = resolve_path(
                    base_dir,
                    &configured.starter_template,
                    "project_types.latex.starter_template",
                )?;
                Some(read_template(&template_path, "LaTeX")?)
            }
            None => None,
        };
        let builtin_templates = load_builtin_templates(
            base_dir,
            file.template_gallery,
            &project_types,
            &accent_color,
        )?;
        let experience = load_experience(
            base_dir,
            file.experience,
            &project_types,
            &frontend_features.included,
            &processing_operations,
        )?;

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
            project_types,
            frontend_features,
            ai_assistant,
            document_processing: DocumentProcessingDistributionConfig {
                allowed_operations: processing_operations,
                operation_policies: processing_operation_policies,
            },
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

fn validate_frontend_features(
    included: Vec<FrontendFeature>,
    default_enabled: Vec<FrontendFeature>,
) -> Result<FrontendFeaturesConfig, String> {
    let mut normalized_included = Vec::with_capacity(included.len());
    for feature in included {
        if normalized_included.contains(&feature) {
            return Err("frontend_features.included must not contain duplicates".to_string());
        }
        normalized_included.push(feature);
    }
    let mut normalized_defaults = Vec::with_capacity(default_enabled.len());
    for feature in default_enabled {
        if normalized_defaults.contains(&feature) {
            return Err(
                "frontend_features.default_enabled must not contain duplicates".to_string(),
            );
        }
        if !normalized_included.contains(&feature) {
            return Err(format!(
                "frontend feature {feature} cannot be enabled by default unless it is included"
            ));
        }
        normalized_defaults.push(feature);
    }
    Ok(FrontendFeaturesConfig {
        included: normalized_included,
        default_enabled: normalized_defaults,
    })
}

fn validate_processing_operations(
    values: Vec<ProcessingOperation>,
    project_types: &[ProjectType],
) -> Result<Vec<ProcessingOperation>, String> {
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        if normalized.contains(&value) {
            return Err(
                "document_processing.allowed_operations must not contain duplicates".to_string(),
            );
        }
        if value
            .project_type()
            .is_some_and(|project_type| !project_types.contains(&project_type))
            || value
                .result_project_type()
                .is_some_and(|project_type| !project_types.contains(&project_type))
        {
            return Err(format!(
                "document_processing.allowed_operations cannot include {value} without its project type"
            ));
        }
        normalized.push(value);
    }
    Ok(normalized)
}

fn validate_processing_operation_policies(
    values: Vec<ProcessingOperationPolicyFile>,
    allowed_operations: &[ProcessingOperation],
) -> Result<Vec<ProcessingOperationPolicy>, String> {
    let mut policies = Vec::with_capacity(values.len());
    let mut operations = HashSet::new();
    for value in values {
        if !allowed_operations.contains(&value.operation) {
            return Err(format!(
                "document_processing.operation_policies cannot configure disabled operation {}",
                value.operation
            ));
        }
        if value.operation.project_type() != Some(ProjectType::Typst) {
            return Err(format!(
                "document_processing.operation_policies cannot require Typst packages for {}",
                value.operation
            ));
        }
        if !operations.insert(value.operation) {
            return Err(format!(
                "document_processing.operation_policies repeats operation {}",
                value.operation
            ));
        }
        if value.required_typst_packages.is_empty() {
            return Err(format!(
                "document_processing.operation_policies for {} must contain a requirement",
                value.operation
            ));
        }
        let mut requirements = Vec::with_capacity(value.required_typst_packages.len());
        let mut identities = HashSet::new();
        for requirement in value.required_typst_packages {
            let identity = format!("@{}/{}", requirement.namespace, requirement.name);
            if !identities.insert(identity.clone()) {
                return Err(format!(
                    "document_processing.operation_policies for {} repeats package {identity}",
                    value.operation
                ));
            }
            let requirement = TypstPackageRequirement::parse(
                requirement.namespace,
                requirement.name,
                requirement.allowed_versions,
            )
            .ok_or_else(|| {
                format!(
                    "document_processing.operation_policies for {} contains invalid package {identity}",
                    value.operation
                )
            })?;
            requirements.push(requirement);
        }
        policies.push(ProcessingOperationPolicy {
            operation: value.operation,
            required_typst_packages: requirements,
        });
    }
    Ok(policies)
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
