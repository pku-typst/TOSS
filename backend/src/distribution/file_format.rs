//! Strict JSON representation of a distribution configuration file.

use crate::distribution::FrontendFeature;
use crate::document_processing::ProcessingOperation;
use crate::experience::{ExperienceResourceKind, ExperienceVisibility};
use crate::workspace::ProjectType;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DistributionFile {
    pub(super) schema: u32,
    pub(super) id: String,
    pub(super) product: ProductFile,
    pub(super) git: GitFile,
    pub(super) project_types: ProjectTypesFile,
    pub(super) frontend_features: FrontendFeaturesFile,
    #[serde(default)]
    pub(super) ai_assistant: Option<AiAssistantFile>,
    pub(super) document_processing: DocumentProcessingFile,
    pub(super) typst: TypstFile,
    pub(super) template_gallery: TemplateGalleryFile,
    pub(super) experience: ExperienceFile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AiAssistantFile {
    pub(super) connection_policy: AiConnectionPolicyFile,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum AiConnectionPolicyFile {
    UserDefined,
    ManagedCatalog {
        provider: Box<ManagedAiProviderFile>,
        default_model_profile: String,
        model_profiles: Vec<ManagedAiModelProfileFile>,
        #[serde(default)]
        custom_profiles: Option<ManagedAiCustomProfilesFile>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManagedAiProviderFile {
    pub(super) id: String,
    pub(super) label: LocalizedTextFile,
    pub(super) credential_label: LocalizedTextFile,
    pub(super) protocol: String,
    pub(super) base_url: String,
    pub(super) catalog: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManagedAiModelProfileFile {
    pub(super) id: String,
    pub(super) model: String,
    pub(super) label: LocalizedTextFile,
    pub(super) context_window: u64,
    pub(super) max_output_tokens: u64,
    pub(super) reasoning: bool,
    #[serde(default)]
    pub(super) request_overrides: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManagedAiCustomProfilesFile {
    pub(super) enabled: bool,
    pub(super) require_catalog_match: bool,
    pub(super) defaults: ManagedAiCustomProfileDefaultsFile,
    pub(super) limits: ManagedAiCustomProfileLimitsFile,
    pub(super) max_saved_profiles: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManagedAiCustomProfileDefaultsFile {
    pub(super) context_window: u64,
    pub(super) max_output_tokens: u64,
    pub(super) reasoning: bool,
    #[serde(default)]
    pub(super) request_overrides: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManagedAiCustomProfileLimitsFile {
    pub(super) min_context_window: u64,
    pub(super) max_context_window: u64,
    pub(super) min_output_tokens: u64,
    pub(super) max_output_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExperienceFile {
    pub(super) landing: LandingFile,
    pub(super) resources: Vec<ExperienceResourceFile>,
    pub(super) help: ExperienceHelpFile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LandingFile {
    pub(super) headline: LocalizedTextFile,
    pub(super) summary: LocalizedTextFile,
    pub(super) highlights: Vec<LandingHighlightFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LandingHighlightFile {
    pub(super) title: LocalizedTextFile,
    pub(super) description: LocalizedTextFile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExperienceResourceFile {
    pub(super) id: String,
    pub(super) kind: ExperienceResourceKind,
    pub(super) label: LocalizedTextFile,
    pub(super) description: LocalizedTextFile,
    pub(super) url: String,
    pub(super) visibility: ExperienceVisibility,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExperienceHelpFile {
    pub(super) topics: Vec<ExperienceHelpTopicFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExperienceHelpTopicFile {
    pub(super) id: String,
    pub(super) title: LocalizedTextFile,
    pub(super) summary: LocalizedTextFile,
    pub(super) sources: LocalizedHelpSourceFile,
    pub(super) visibility: ExperienceVisibility,
    #[serde(default)]
    pub(super) availability: HelpAvailabilityFile,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HelpAvailabilityFile {
    #[serde(default)]
    pub(super) project_types: Vec<ProjectType>,
    #[serde(default)]
    pub(super) frontend_features: Vec<FrontendFeature>,
    #[serde(default)]
    pub(super) processing_operations: Vec<ProcessingOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LocalizedHelpSourceFile {
    pub(super) en: String,
    #[serde(rename = "zh-CN")]
    pub(super) zh_cn: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TemplateGalleryFile {
    pub(super) builtins: Vec<BuiltinTemplateFileConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BuiltinTemplateFileConfig {
    pub(super) id: String,
    pub(super) name: LocalizedTextFile,
    pub(super) description: LocalizedTextFile,
    pub(super) category: String,
    #[serde(default)]
    pub(super) tags: Vec<String>,
    pub(super) project_type: ProjectType,
    pub(super) entry_file: String,
    pub(super) source_dir: String,
    #[serde(default)]
    pub(super) thumbnail: Option<String>,
    #[serde(default)]
    pub(super) featured: bool,
    #[serde(default)]
    pub(super) accent_color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LocalizedTextFile {
    pub(super) en: String,
    #[serde(rename = "zh-CN")]
    pub(super) zh_cn: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProductFile {
    pub(super) name: String,
    pub(super) description: LocalizedTextFile,
    #[serde(default)]
    pub(super) name_managed: bool,
    pub(super) brand_mark: String,
    pub(super) accent_color: String,
    pub(super) accent_text_color: String,
    pub(super) favicon: String,
    #[serde(default)]
    pub(super) touch_icon: Option<String>,
    #[serde(default)]
    pub(super) indexing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GitFile {
    pub(super) checkpoint_branch_prefix: String,
    pub(super) fallback_owner_name: String,
    pub(super) fallback_email_domain: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProjectTypesFile {
    pub(super) typst: ProjectTypeFile,
    #[serde(default)]
    pub(super) latex: Option<ProjectTypeFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProjectTypeFile {
    pub(super) starter_template: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FrontendFeaturesFile {
    #[serde(default)]
    pub(super) included: Vec<FrontendFeature>,
    #[serde(default)]
    pub(super) default_enabled: Vec<FrontendFeature>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DocumentProcessingFile {
    #[serde(default)]
    pub(super) allowed_operations: Vec<ProcessingOperation>,
    #[serde(default)]
    pub(super) operation_policies: Vec<ProcessingOperationPolicyFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProcessingOperationPolicyFile {
    pub(super) operation: ProcessingOperation,
    #[serde(default)]
    pub(super) required_typst_packages: Vec<TypstPackageRequirementFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TypstPackageRequirementFile {
    pub(super) namespace: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) allowed_versions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TypstFile {
    pub(super) builtin_dir: String,
}
