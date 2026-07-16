//! Audience-aware product experience and help content.

use super::{ExperienceResourceKind, ExperienceVisibility};
use crate::distribution::{DistributionConfig, FrontendFeature, LocalizedText};
use crate::document_processing::ProcessingOperation;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExperienceProduct {
    pub name: String,
    pub description: LocalizedText,
    pub brand_mark: String,
    pub accent_color: String,
    pub accent_text_color: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExperienceLandingHighlight {
    pub title: LocalizedText,
    pub description: LocalizedText,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExperienceLanding {
    pub headline: LocalizedText,
    pub summary: LocalizedText,
    pub highlights: Vec<ExperienceLandingHighlight>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ExperienceResource {
    pub id: String,
    pub kind: ExperienceResourceKind,
    pub label: LocalizedText,
    pub description: LocalizedText,
    pub url: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct Experience {
    pub distribution_id: String,
    pub product: ExperienceProduct,
    pub landing: ExperienceLanding,
    pub resources: Vec<ExperienceResource>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct HelpTopic {
    pub id: String,
    pub title: LocalizedText,
    pub summary: LocalizedText,
    pub content: LocalizedText,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct HelpContent {
    pub topics: Vec<HelpTopic>,
    pub resources: Vec<ExperienceResource>,
}

fn visible_to_viewer(visibility: ExperienceVisibility, authenticated: bool) -> bool {
    visibility == ExperienceVisibility::Public || authenticated
}

fn experience_resource(
    resource: &crate::distribution::experience_content::ExperienceResource,
) -> ExperienceResource {
    ExperienceResource {
        id: resource.id.clone(),
        kind: resource.kind,
        label: resource.label.clone(),
        description: resource.description.clone(),
        url: resource.url.clone(),
    }
}

fn visible_resources(
    distribution: &DistributionConfig,
    authenticated: bool,
) -> Vec<ExperienceResource> {
    distribution
        .experience
        .resources
        .iter()
        .filter(|resource| visible_to_viewer(resource.visibility, authenticated))
        .map(experience_resource)
        .collect()
}

pub(crate) fn load_experience(
    distribution: &DistributionConfig,
    authenticated: bool,
) -> Experience {
    Experience {
        distribution_id: distribution.id.clone(),
        product: ExperienceProduct {
            name: distribution.product.name.clone(),
            description: distribution.product.description.clone(),
            brand_mark: distribution.product.brand_mark.clone(),
            accent_color: distribution.product.accent_color.clone(),
            accent_text_color: distribution.product.accent_text_color.clone(),
        },
        landing: ExperienceLanding {
            headline: distribution.experience.landing.headline.clone(),
            summary: distribution.experience.landing.summary.clone(),
            highlights: distribution
                .experience
                .landing
                .highlights
                .iter()
                .map(|highlight| ExperienceLandingHighlight {
                    title: highlight.title.clone(),
                    description: highlight.description.clone(),
                })
                .collect(),
        },
        resources: visible_resources(distribution, authenticated),
    }
}

pub(crate) fn load_help_content(
    distribution: &DistributionConfig,
    enabled_frontend_features: &[FrontendFeature],
    configured_processing_operations: &[ProcessingOperation],
    authenticated: bool,
) -> HelpContent {
    HelpContent {
        topics: distribution
            .experience
            .help_topics
            .iter()
            .filter(|topic| visible_to_viewer(topic.visibility, authenticated))
            .filter(|topic| {
                topic
                    .availability
                    .project_types
                    .iter()
                    .all(|project_type| distribution.supports_project_type(*project_type))
                    && topic
                        .availability
                        .frontend_features
                        .iter()
                        .all(|feature| enabled_frontend_features.contains(feature))
                    && topic
                        .availability
                        .processing_operations
                        .iter()
                        .all(|operation| configured_processing_operations.contains(operation))
            })
            .map(|topic| HelpTopic {
                id: topic.id.clone(),
                title: topic.title.clone(),
                summary: topic.summary.clone(),
                content: topic.content.clone(),
            })
            .collect(),
        resources: visible_resources(distribution, authenticated),
    }
}

#[cfg(test)]
mod tests {
    use super::{load_experience, load_help_content};
    use crate::distribution::experience_content::{
        ExperienceHelpTopic, ExperienceResource, HelpAvailability,
    };
    use crate::distribution::LocalizedText;
    use crate::experience::{ExperienceResourceKind, ExperienceVisibility};

    fn text(value: &str) -> LocalizedText {
        LocalizedText {
            en: value.to_string(),
            zh_cn: value.to_string(),
        }
    }

    #[test]
    fn authenticated_content_is_excluded_from_public_projections() {
        let mut distribution = crate::distribution::DistributionConfig::default();
        distribution.experience.resources.push(ExperienceResource {
            id: "internal-resource".to_string(),
            kind: ExperienceResourceKind::Support,
            label: text("Internal resource"),
            description: text("Authenticated only"),
            url: "https://example.com/internal".to_string(),
            visibility: ExperienceVisibility::Authenticated,
        });
        distribution
            .experience
            .help_topics
            .push(ExperienceHelpTopic {
                id: "internal-help".to_string(),
                title: text("Internal help"),
                summary: text("Authenticated only"),
                content: text("Content"),
                visibility: ExperienceVisibility::Authenticated,
                availability: HelpAvailability::default(),
            });

        let public_experience = load_experience(&distribution, false);
        let authenticated_experience = load_experience(&distribution, true);
        assert!(!public_experience
            .resources
            .iter()
            .any(|resource| resource.id == "internal-resource"));
        assert!(authenticated_experience
            .resources
            .iter()
            .any(|resource| resource.id == "internal-resource"));

        let public_help = load_help_content(&distribution, &[], &[], false);
        let authenticated_help = load_help_content(&distribution, &[], &[], true);
        assert!(!public_help
            .topics
            .iter()
            .any(|topic| topic.id == "internal-help"));
        assert!(authenticated_help
            .topics
            .iter()
            .any(|topic| topic.id == "internal-help"));
    }
}
