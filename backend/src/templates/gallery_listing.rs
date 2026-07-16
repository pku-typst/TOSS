//! Built-in and project-backed template gallery composition.

use super::TemplateSource;
use crate::access::{
    list_project_catalog_access, list_user_identities, IdentityLookupError, ProjectCatalogAccess,
};
use crate::distribution::{DistributionConfig, LocalizedText};
use crate::workspace::{list_project_template_sources, project_ids_with_thumbnails, ProjectType};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct TemplateGalleryItem {
    pub id: String,
    pub source: TemplateSource,
    #[schema(required)]
    pub project_id: Option<Uuid>,
    pub name: LocalizedText,
    pub description: LocalizedText,
    pub category: String,
    pub tags: Vec<String>,
    pub project_type: ProjectType,
    #[schema(required)]
    pub owner_display_name: Option<String>,
    pub featured: bool,
    pub can_edit: bool,
    pub can_read: bool,
    pub has_thumbnail: bool,
    #[schema(required)]
    pub updated_at: Option<DateTime<Utc>>,
    pub accent_color: String,
}

#[derive(Debug, Error)]
pub(super) enum ListTemplateGalleryError {
    #[error("template gallery access lookup failed")]
    CatalogAccess(#[source] sqlx::Error),
    #[error("template gallery project lookup failed")]
    Workspace(#[source] sqlx::Error),
    #[error("template gallery thumbnail lookup failed")]
    Thumbnail(#[source] sqlx::Error),
    #[error(transparent)]
    Identity(#[from] IdentityLookupError),
}

pub(crate) async fn list_template_gallery(
    db: &PgPool,
    distribution: &DistributionConfig,
    actor_user_id: Uuid,
) -> Result<Vec<TemplateGalleryItem>, ListTemplateGalleryError> {
    let mut templates = distribution
        .builtin_templates
        .iter()
        .map(|template| TemplateGalleryItem {
            id: template.id.clone(),
            source: TemplateSource::Builtin,
            project_id: None,
            name: template.name.clone(),
            description: template.description.clone(),
            category: template.category.clone(),
            tags: template.tags.clone(),
            project_type: template.project_type,
            owner_display_name: None,
            featured: template.featured,
            can_edit: false,
            can_read: true,
            has_thumbnail: template.thumbnail.is_some(),
            updated_at: None,
            accent_color: template.accent_color.clone(),
        })
        .collect::<Vec<_>>();
    let catalog_access = list_project_catalog_access(db, actor_user_id)
        .await
        .map_err(ListTemplateGalleryError::CatalogAccess)?;
    let accessible_project_ids = catalog_access
        .iter()
        .map(ProjectCatalogAccess::project_id)
        .collect::<Vec<_>>();
    let mut access_by_project = catalog_access
        .into_iter()
        .map(|access| (access.project_id(), access))
        .collect::<HashMap<_, _>>();
    let custom_templates =
        list_project_template_sources(db, actor_user_id, &accessible_project_ids)
            .await
            .map_err(ListTemplateGalleryError::Workspace)?;
    let custom_template_ids = custom_templates
        .iter()
        .map(|template| template.id)
        .collect::<Vec<_>>();
    let thumbnail_project_ids = project_ids_with_thumbnails(db, &custom_template_ids)
        .await
        .map_err(ListTemplateGalleryError::Thumbnail)?
        .into_iter()
        .collect::<HashSet<_>>();
    let owner_ids = custom_templates
        .iter()
        .filter_map(|template| template.owner_user_id)
        .collect::<Vec<_>>();
    let owner_names = list_user_identities(db, &owner_ids)
        .await?
        .into_iter()
        .map(|user| (user.id, user.display_name))
        .collect::<HashMap<_, _>>();
    for template in custom_templates {
        if !distribution.supports_project_type(template.project_type) {
            continue;
        }
        let personal = template.owner_user_id == Some(actor_user_id);
        let access = access_by_project.remove(&template.id);
        if !personal
            && !access
                .as_ref()
                .is_some_and(|access| access.permits_catalog_entry(true))
        {
            continue;
        }
        let description = custom_template_description(&template.description, personal);
        let source = if personal {
            TemplateSource::Personal
        } else {
            TemplateSource::Shared
        };
        templates.push(TemplateGalleryItem {
            id: template.id.to_string(),
            source,
            project_id: Some(template.id),
            name: LocalizedText {
                en: template.name.clone(),
                zh_cn: template.name,
            },
            description,
            category: "custom".to_string(),
            tags: vec![source.as_ref().to_string()],
            project_type: template.project_type,
            owner_display_name: Some(
                template
                    .owner_user_id
                    .and_then(|owner_user_id| owner_names.get(&owner_user_id).cloned())
                    .unwrap_or_else(|| "Unknown".to_string()),
            ),
            featured: false,
            can_edit: personal,
            can_read: personal || access.is_some_and(|access| access.can_read()),
            has_thumbnail: thumbnail_project_ids.contains(&template.id),
            updated_at: Some(template.updated_at),
            accent_color: distribution.product.accent_color.clone(),
        });
    }
    Ok(templates)
}

fn custom_template_description(description: &str, personal: bool) -> LocalizedText {
    if !description.trim().is_empty() {
        return LocalizedText {
            en: description.to_string(),
            zh_cn: description.to_string(),
        };
    }
    if personal {
        LocalizedText {
            en: "A reusable template from your projects.".to_string(),
            zh_cn: "从你的项目创建的可复用模板。".to_string(),
        }
    } else {
        LocalizedText {
            en: "A template shared with you.".to_string(),
            zh_cn: "与你共享的模板。".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::custom_template_description;

    #[test]
    fn empty_custom_template_descriptions_reflect_ownership() {
        let personal = custom_template_description(" ", true);
        let shared = custom_template_description("", false);
        assert_ne!(personal.en, shared.en);
        assert_ne!(personal.zh_cn, shared.zh_cn);
    }
}
