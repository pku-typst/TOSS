//! Distribution-provided landing, resource, and help content.

use super::file_format::ExperienceFile;
use super::FrontendFeature;
use super::{
    resolve_distribution_file, validate_localized_text, validate_slug, LocalizedText,
    MAX_HELP_TOPIC_BYTES,
};
use crate::document_processing::ProcessingOperation;
use crate::experience::{ExperienceResourceKind, ExperienceVisibility};
use crate::workspace::ProjectType;
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct ExperienceConfig {
    pub landing: LandingConfig,
    pub resources: Vec<ExperienceResource>,
    pub help_topics: Vec<ExperienceHelpTopic>,
}

#[derive(Clone, Debug)]
pub struct LandingConfig {
    pub headline: LocalizedText,
    pub summary: LocalizedText,
    pub highlights: Vec<LandingHighlight>,
}

#[derive(Clone, Debug)]
pub struct LandingHighlight {
    pub title: LocalizedText,
    pub description: LocalizedText,
}

#[derive(Clone, Debug)]
pub struct ExperienceResource {
    pub id: String,
    pub kind: ExperienceResourceKind,
    pub label: LocalizedText,
    pub description: LocalizedText,
    pub url: String,
    pub visibility: ExperienceVisibility,
}

#[derive(Clone, Debug)]
pub struct ExperienceHelpTopic {
    pub id: String,
    pub title: LocalizedText,
    pub summary: LocalizedText,
    pub content: LocalizedText,
    pub visibility: ExperienceVisibility,
    pub availability: HelpAvailability,
}

#[derive(Clone, Debug, Default)]
pub struct HelpAvailability {
    pub project_types: Vec<ProjectType>,
    pub frontend_features: Vec<FrontendFeature>,
    pub processing_operations: Vec<ProcessingOperation>,
}

pub(super) fn load_experience(
    base_dir: &Path,
    configured: ExperienceFile,
    project_types: &[ProjectType],
    frontend_features: &[FrontendFeature],
    processing_operations: &[ProcessingOperation],
) -> Result<ExperienceConfig, String> {
    if configured.landing.highlights.is_empty() || configured.landing.highlights.len() > 6 {
        return Err("experience.landing.highlights must contain between 1 and 6 items".to_string());
    }
    let landing = LandingConfig {
        headline: validate_localized_text(
            configured.landing.headline,
            "experience.landing.headline",
            120,
        )?,
        summary: validate_localized_text(
            configured.landing.summary,
            "experience.landing.summary",
            320,
        )?,
        highlights: configured
            .landing
            .highlights
            .into_iter()
            .map(|highlight| {
                Ok(LandingHighlight {
                    title: validate_localized_text(
                        highlight.title,
                        "experience.landing.highlights[].title",
                        80,
                    )?,
                    description: validate_localized_text(
                        highlight.description,
                        "experience.landing.highlights[].description",
                        220,
                    )?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    };

    if configured.resources.is_empty() || configured.resources.len() > 16 {
        return Err("experience.resources must contain between 1 and 16 items".to_string());
    }
    let mut resource_ids = HashSet::new();
    let mut resources = Vec::with_capacity(configured.resources.len());
    for resource in configured.resources {
        validate_slug(&resource.id, "experience.resources[].id")?;
        if !resource_ids.insert(resource.id.clone()) {
            return Err(format!(
                "experience.resources contains duplicate id '{}'",
                resource.id
            ));
        }
        let url = validate_experience_url(&resource.url, &resource.id)?;
        resources.push(ExperienceResource {
            id: resource.id,
            kind: resource.kind,
            label: validate_localized_text(resource.label, "experience.resources[].label", 80)?,
            description: validate_localized_text(
                resource.description,
                "experience.resources[].description",
                220,
            )?,
            url,
            visibility: resource.visibility,
        });
    }

    if configured.help.topics.is_empty() || configured.help.topics.len() > 32 {
        return Err("experience.help.topics must contain between 1 and 32 items".to_string());
    }
    let mut topic_ids = HashSet::new();
    let mut help_topics = Vec::with_capacity(configured.help.topics.len());
    for topic in configured.help.topics {
        validate_slug(&topic.id, "experience.help.topics[].id")?;
        if !topic_ids.insert(topic.id.clone()) {
            return Err(format!(
                "experience.help.topics contains duplicate id '{}'",
                topic.id
            ));
        }
        let availability = HelpAvailability {
            project_types: validate_requirements(
                topic.availability.project_types,
                project_types,
                "experience.help.topics[].availability.project_types",
            )?,
            frontend_features: validate_requirements(
                topic.availability.frontend_features,
                frontend_features,
                "experience.help.topics[].availability.frontend_features",
            )?,
            processing_operations: validate_requirements(
                topic.availability.processing_operations,
                processing_operations,
                "experience.help.topics[].availability.processing_operations",
            )?,
        };
        help_topics.push(ExperienceHelpTopic {
            id: topic.id,
            title: validate_localized_text(topic.title, "experience.help.topics[].title", 100)?,
            summary: validate_localized_text(
                topic.summary,
                "experience.help.topics[].summary",
                240,
            )?,
            content: LocalizedText {
                en: load_help_topic_source(
                    base_dir,
                    &topic.sources.en,
                    "experience.help.topics[].sources.en",
                )?,
                zh_cn: load_help_topic_source(
                    base_dir,
                    &topic.sources.zh_cn,
                    "experience.help.topics[].sources.zh-CN",
                )?,
            },
            visibility: topic.visibility,
            availability,
        });
    }

    Ok(ExperienceConfig {
        landing,
        resources,
        help_topics,
    })
}

fn validate_requirements<T: Copy + std::fmt::Display + PartialEq>(
    configured: Vec<T>,
    available: &[T],
    field: &str,
) -> Result<Vec<T>, String> {
    let mut normalized = Vec::with_capacity(configured.len());
    for value in configured {
        if normalized.contains(&value) {
            return Err(format!("{field} must not contain duplicates"));
        }
        if !available.contains(&value) {
            return Err(format!(
                "{field} requires {value}, which is not provided by the distribution"
            ));
        }
        normalized.push(value);
    }
    Ok(normalized)
}

fn validate_experience_url(raw: &str, id: &str) -> Result<String, String> {
    let value = raw.trim();
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| format!("experience resource '{id}' URL must be an absolute HTTPS URL"))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || value.len() > 2048
    {
        return Err(format!(
            "experience resource '{id}' URL must be a credential-free HTTPS URL"
        ));
    }
    Ok(parsed.to_string())
}

fn load_help_topic_source(base_dir: &Path, raw: &str, field: &str) -> Result<String, String> {
    let path = resolve_distribution_file(base_dir, raw, field, MAX_HELP_TOPIC_BYTES)?;
    if !path
        .to_str()
        .is_some_and(|value| value.to_ascii_lowercase().ends_with(".md"))
    {
        return Err(format!("{field} must reference a Markdown file"));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {field} {}: {error}", path.display()))?;
    if content.trim().is_empty() {
        return Err(format!("{field} Markdown file must not be empty"));
    }
    Ok(content)
}
