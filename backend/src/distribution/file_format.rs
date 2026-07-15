//! Strict JSON representation of a distribution configuration file.

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
    pub(super) capabilities: CapabilitiesFile,
    pub(super) typst: TypstFile,
    pub(super) template_gallery: TemplateGalleryFile,
    pub(super) experience: ExperienceFile,
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
pub(super) struct CapabilitiesFile {
    pub(super) project_types: Vec<ProjectType>,
    #[serde(default)]
    pub(super) processing_operations: Vec<ProcessingOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TypstFile {
    pub(super) builtin_dir: String,
    pub(super) starter_templates: StarterTemplatesFile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StarterTemplatesFile {
    pub(super) typst: String,
    #[serde(default)]
    pub(super) latex: Option<String>,
}
