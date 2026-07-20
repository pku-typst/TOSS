mod ai_assistant;
pub(crate) mod experience_content;
mod file_format;
mod loader;
mod localized_text;
mod source_files;
pub(crate) mod template_catalog;

use crate::document_processing::{ProcessingInputProfileSelector, ProcessingOperation};
use crate::experience::{ExperienceResourceKind, ExperienceVisibility};
use crate::text_enum::text_enum;
use crate::typst_runtime::{TypstPackageRequirement, TypstProjectDependencies};
use crate::workspace::ProjectType;
pub use ai_assistant::{AiAssistantConfig, AiConnectionPolicyKind, ManagedAiCatalogConfig};
use experience_content::{ExperienceConfig, ExperienceResource, LandingConfig, LandingHighlight};
use localized_text::validate_localized_text;
pub(crate) use localized_text::LocalizedText;
use source_files::{read_template, resolve_distribution_file, resolve_path};
use std::path::PathBuf;
use template_catalog::{BuiltinTemplate, BuiltinTemplateFile};
use thiserror::Error;
use uuid::Uuid;

const CONFIG_SCHEMA_VERSION: u32 = 6;
const MAX_TEMPLATE_FILES: usize = 4096;
const MAX_TEMPLATE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEMPLATE_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TEMPLATE_THUMBNAIL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PRODUCT_ASSET_BYTES: u64 = 512 * 1024;
const MAX_HELP_TOPIC_BYTES: u64 = 256 * 1024;
const DEFAULT_FAVICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2563eb"/><path d="M17 16h30v9H37v25H27V25H17z" fill="#fff"/></svg>"##;
const DEFAULT_TYPST_TEMPLATE: &str = r#"= Welcome to Typst Collaboration

Start writing your Typst document here.
"#;
const DEFAULT_LATEX_TEMPLATE: &str = r#"\documentclass{article}
\begin{document}
Welcome to Typst Collaboration.
\end{document}
"#;

#[derive(Clone, Debug)]
pub struct DistributionConfig {
    pub id: String,
    pub product: ProductConfig,
    pub git: GitConfig,
    pub project_types: Vec<ProjectType>,
    pub frontend_features: FrontendFeaturesConfig,
    pub ai_assistant: Option<AiAssistantConfig>,
    pub document_processing: DocumentProcessingDistributionConfig,
    pub experience: ExperienceConfig,
    pub typst_builtin_dir: Option<PathBuf>,
    pub builtin_templates: Vec<BuiltinTemplate>,
    typst_template: String,
    latex_template: Option<String>,
    source_path: Option<PathBuf>,
}

type ArcBytes = std::sync::Arc<[u8]>;

#[derive(Clone, Debug)]
pub struct ProductConfig {
    pub name: String,
    pub description: LocalizedText,
    pub name_managed: bool,
    pub brand_mark: String,
    pub accent_color: String,
    pub accent_text_color: String,
    pub favicon: ProductAsset,
    pub touch_icon: Option<ProductAsset>,
    pub indexing: bool,
}

#[derive(Clone, Debug)]
pub struct ProductAsset {
    pub bytes: ArcBytes,
    pub content_type: String,
}

#[derive(Clone, Debug)]
pub struct GitConfig {
    pub checkpoint_branch_prefix: CheckpointBranchPrefix,
    pub fallback_owner_name: String,
    pub fallback_email_domain: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointBranchPrefix(String);

impl CheckpointBranchPrefix {
    pub(crate) fn parse(raw: &str) -> Result<Self, InvalidCheckpointBranchPrefix> {
        let value = raw.trim();
        let example_branch = format!("{value}{}", Uuid::nil());
        if value.is_empty()
            || value.len() > 64
            || !value.ends_with('/')
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'/')
            })
            || !matches!(git2::Branch::name_is_valid(&example_branch), Ok(true))
        {
            return Err(InvalidCheckpointBranchPrefix);
        }
        Ok(Self(value.to_string()))
    }

    pub(crate) fn branch_for(&self, project_id: Uuid) -> String {
        format!("{}{project_id}", self.0)
    }
}

impl Default for CheckpointBranchPrefix {
    fn default() -> Self {
        Self("workspace/".to_string())
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("checkpoint branch prefix is invalid")]
pub(crate) struct InvalidCheckpointBranchPrefix;

text_enum! {
    #[derive(Hash)]
    #[schema(rename_all = "snake_case")]
    pub enum FrontendFeature {
        AiAssistant => "ai_assistant",
    }
}

#[derive(Clone, Debug)]
pub struct FrontendFeaturesConfig {
    pub included: Vec<FrontendFeature>,
    pub default_enabled: Vec<FrontendFeature>,
}

#[derive(Clone, Debug)]
pub struct DocumentProcessingDistributionConfig {
    pub allowed_operations: Vec<ProcessingOperation>,
    pub operation_policies: Vec<ProcessingOperationPolicy>,
    pub input_profiles: Vec<ProcessingOperationInputProfiles>,
}

#[derive(Clone, Debug)]
pub struct ProcessingOperationPolicy {
    pub operation: ProcessingOperation,
    pub required_typst_packages: Vec<TypstPackageRequirement>,
}

#[derive(Clone, Debug)]
pub struct ProcessingOperationInputProfiles {
    pub operation: ProcessingOperation,
    pub selector: ProcessingInputProfileSelector,
}

impl Default for DistributionConfig {
    fn default() -> Self {
        Self {
            id: "community".to_string(),
            product: ProductConfig {
                name: "Typst Collaboration".to_string(),
                description: LocalizedText {
                    en: "Collaborative Typst editing with live browser preview.".to_string(),
                    zh_cn: "带浏览器实时预览的 Typst 协作编辑平台。".to_string(),
                },
                name_managed: false,
                brand_mark: "T".to_string(),
                accent_color: "#2563eb".to_string(),
                accent_text_color: "#ffffff".to_string(),
                favicon: ProductAsset {
                    bytes: std::sync::Arc::from(DEFAULT_FAVICON_SVG.as_bytes()),
                    content_type: "image/svg+xml".to_string(),
                },
                touch_icon: None,
                indexing: true,
            },
            git: GitConfig {
                checkpoint_branch_prefix: CheckpointBranchPrefix::default(),
                fallback_owner_name: "Workspace Owner".to_string(),
                fallback_email_domain: "workspace.local".to_string(),
            },
            project_types: vec![ProjectType::Typst, ProjectType::Latex],
            frontend_features: FrontendFeaturesConfig {
                included: Vec::new(),
                default_enabled: Vec::new(),
            },
            ai_assistant: None,
            document_processing: DocumentProcessingDistributionConfig {
                allowed_operations: vec![ProcessingOperation::LatexCompilePdfV1],
                operation_policies: Vec::new(),
                input_profiles: Vec::new(),
            },
            experience: ExperienceConfig {
                landing: LandingConfig {
                    headline: LocalizedText {
                        en: "Write together. Preview instantly.".to_string(),
                        zh_cn: "共同创作，即时预览。".to_string(),
                    },
                    summary: LocalizedText {
                        en: "Create, review, and share Typst projects directly in the browser."
                            .to_string(),
                        zh_cn: "直接在浏览器中创建、评审和共享 Typst 项目。".to_string(),
                    },
                    highlights: vec![LandingHighlight {
                        title: LocalizedText {
                            en: "Live collaboration".to_string(),
                            zh_cn: "实时协作".to_string(),
                        },
                        description: LocalizedText {
                            en: "Edit the same source with your team.".to_string(),
                            zh_cn: "与团队共同编辑同一份源文件。".to_string(),
                        },
                    }],
                },
                resources: vec![ExperienceResource {
                    id: "typst-docs".to_string(),
                    kind: ExperienceResourceKind::Documentation,
                    label: LocalizedText {
                        en: "Typst documentation".to_string(),
                        zh_cn: "Typst 官方文档".to_string(),
                    },
                    description: LocalizedText {
                        en: "Language tutorial and reference.".to_string(),
                        zh_cn: "Typst 语言教程与参考。".to_string(),
                    },
                    url: "https://typst.app/docs/".to_string(),
                    visibility: ExperienceVisibility::Public,
                }],
                help_topics: Vec::new(),
            },
            typst_builtin_dir: None,
            builtin_templates: vec![BuiltinTemplate {
                id: "blank-document".to_string(),
                name: LocalizedText {
                    en: "Blank document".to_string(),
                    zh_cn: "空白文档".to_string(),
                },
                description: LocalizedText {
                    en: "Start with a minimal Typst document.".to_string(),
                    zh_cn: "从最简 Typst 文档开始。".to_string(),
                },
                category: "document".to_string(),
                tags: vec!["blank".to_string()],
                project_type: ProjectType::Typst,
                entry_file_path: "main.typ".to_string(),
                featured: true,
                accent_color: "#2563eb".to_string(),
                files: vec![BuiltinTemplateFile {
                    path: "main.typ".to_string(),
                    bytes: std::sync::Arc::from(DEFAULT_TYPST_TEMPLATE.as_bytes()),
                    content_type: "text/plain; charset=utf-8".to_string(),
                    is_text: true,
                }],
                thumbnail: None,
            }],
            typst_template: DEFAULT_TYPST_TEMPLATE.to_string(),
            latex_template: Some(DEFAULT_LATEX_TEMPLATE.to_string()),
            source_path: None,
        }
    }
}

impl DistributionConfig {
    pub fn supports_project_type(&self, project_type: ProjectType) -> bool {
        self.project_types.contains(&project_type)
    }

    pub fn includes_frontend_feature(&self, feature: FrontendFeature) -> bool {
        self.frontend_features.included.contains(&feature)
    }

    pub fn supports_processing_operation(&self, operation: ProcessingOperation) -> bool {
        self.document_processing
            .allowed_operations
            .contains(&operation)
    }

    pub(crate) fn processing_operation_applicable(
        &self,
        operation: ProcessingOperation,
        dependencies: Option<&TypstProjectDependencies>,
    ) -> bool {
        let Some(policy) = self
            .document_processing
            .operation_policies
            .iter()
            .find(|policy| policy.operation == operation)
        else {
            return true;
        };
        let Some(dependencies) = dependencies else {
            return false;
        };
        policy.required_typst_packages.iter().all(|requirement| {
            dependencies
                .packages
                .iter()
                .any(|package| requirement.matches(package))
        })
    }

    pub(crate) fn processing_input_profile_selector(
        &self,
        operation: ProcessingOperation,
    ) -> Option<&ProcessingInputProfileSelector> {
        self.document_processing
            .input_profiles
            .iter()
            .find(|profiles| profiles.operation == operation)
            .map(|profiles| &profiles.selector)
    }

    pub fn starter_content(&self, project_type: ProjectType) -> Option<&str> {
        match project_type {
            ProjectType::Typst if self.supports_project_type(ProjectType::Typst) => {
                Some(&self.typst_template)
            }
            ProjectType::Latex if self.supports_project_type(ProjectType::Latex) => {
                self.latex_template.as_deref()
            }
            ProjectType::Typst | ProjectType::Latex => None,
        }
    }

    pub fn builtin_template(&self, id: &str) -> Option<&BuiltinTemplate> {
        self.builtin_templates
            .iter()
            .find(|template| template.id == id)
    }

    pub fn effective_site_name<'a>(&'a self, database_value: &'a str) -> &'a str {
        if self.product.name_managed {
            &self.product.name
        } else {
            database_value
        }
    }

    pub fn source_label(&self) -> String {
        self.source_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "built-in community defaults".to_string())
    }
}

fn validate_slug(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!(
            "{field} must contain only lowercase ASCII letters, digits, and hyphens"
        ));
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::{
        AiConnectionPolicyKind, CheckpointBranchPrefix, DistributionConfig,
        InvalidCheckpointBranchPrefix, ProcessingOperationPolicy,
    };
    use crate::document_processing::ProcessingOperation;
    use crate::experience::ExperienceVisibility;
    use crate::typst_runtime::{PackageSpec, TypstPackageRequirement, TypstProjectDependencies};
    use crate::workspace::ProjectType;
    use std::collections::HashSet;
    use std::error::Error;
    use std::path::Path;
    use uuid::Uuid;

    fn repository_path(relative: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(relative)
    }

    #[test]
    fn loads_community_distribution() -> Result<(), Box<dyn Error>> {
        let config =
            DistributionConfig::load(&repository_path("distributions/community/toss.json"))?;
        assert_eq!(config.id, "community");
        assert_eq!(
            config.ai_assistant.as_ref().map(|config| config.kind()),
            Some(AiConnectionPolicyKind::UserDefined)
        );
        assert_eq!(config.product.brand_mark, "T");
        assert!(!config.product.name_managed);
        assert_eq!(
            config.git.checkpoint_branch_prefix.branch_for(Uuid::nil()),
            "workspace/00000000-0000-0000-0000-000000000000"
        );
        assert_eq!(
            config.project_types,
            [ProjectType::Typst, ProjectType::Latex]
        );
        assert_eq!(
            config.document_processing.allowed_operations,
            [ProcessingOperation::LatexCompilePdfV1]
        );
        assert!(config.supports_project_type(ProjectType::Latex));
        assert!(config
            .starter_content(ProjectType::Typst)
            .is_some_and(|template| template.contains("Welcome to Typst Collaboration")));
        assert!(config.starter_content(ProjectType::Latex).is_some());
        assert_eq!(config.builtin_templates.len(), 4);
        assert!(config
            .builtin_template("structured-report")
            .is_some_and(|template| template.entry_file_path == "main.typ"));
        assert!(config
            .builtin_template("latex-article")
            .is_some_and(|template| template.project_type == ProjectType::Latex));
        assert!(config
            .builtin_templates
            .iter()
            .all(|template| template.thumbnail.is_some() && !template.files.is_empty()));
        assert!(config.product.indexing);
        assert_eq!(config.product.favicon.content_type, "image/svg+xml");
        assert!(config.product.favicon.bytes.starts_with(b"<svg"));
        assert_eq!(config.experience.landing.highlights.len(), 3);
        assert!(config
            .experience
            .resources
            .iter()
            .all(|resource| resource.visibility == ExperienceVisibility::Public));
        assert!(config.experience.resources.iter().all(|resource| {
            resource.url.starts_with("https://typst.app/")
                || resource.url == "https://github.com/typst/typst"
        }));
        assert!(config.experience.help_topics.len() >= 6);
        Ok(())
    }

    #[test]
    fn checkpoint_branch_prefix_owns_git_branch_generation(
    ) -> Result<(), InvalidCheckpointBranchPrefix> {
        let prefix = CheckpointBranchPrefix::parse("  workspace/  ")?;
        let project_id = Uuid::nil();

        assert_eq!(
            prefix.branch_for(project_id),
            "workspace/00000000-0000-0000-0000-000000000000"
        );
        Ok(())
    }

    #[test]
    fn checkpoint_branch_prefix_rejects_invalid_policy_or_git_paths() {
        for value in ["", "Workspace/", "workspace", "workspace//", "workspace../"] {
            assert_eq!(
                CheckpointBranchPrefix::parse(value),
                Err(InvalidCheckpointBranchPrefix)
            );
        }
    }

    #[test]
    fn processing_policy_matches_an_exact_reachable_typst_package(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut config = DistributionConfig::default();
        let requirement = TypstPackageRequirement::parse(
            "local".to_string(),
            "slides".to_string(),
            vec!["0.7.0".to_string()],
        )
        .ok_or("test package requirement is invalid")?;
        config.document_processing.operation_policies = vec![ProcessingOperationPolicy {
            operation: ProcessingOperation::TypstExportPptxV1,
            required_typst_packages: vec![requirement],
        }];
        let matching = TypstProjectDependencies {
            packages: HashSet::from([PackageSpec::parse(
                "local".to_string(),
                "slides".to_string(),
                "0.7.0".to_string(),
            )
            .ok_or("matching test package spec is invalid")?]),
            has_dynamic_imports: false,
        };
        let wrong_version = TypstProjectDependencies {
            packages: HashSet::from([PackageSpec::parse(
                "local".to_string(),
                "slides".to_string(),
                "0.6.0".to_string(),
            )
            .ok_or("wrong-version test package spec is invalid")?]),
            has_dynamic_imports: false,
        };

        assert!(config.processing_operation_applicable(
            ProcessingOperation::TypstExportPptxV1,
            Some(&matching)
        ));
        assert!(!config.processing_operation_applicable(
            ProcessingOperation::TypstExportPptxV1,
            Some(&wrong_version)
        ));
        assert!(
            config.processing_operation_applicable(ProcessingOperation::LatexCompilePdfV1, None)
        );
        Ok(())
    }
}
