//! Project catalog composition owned by Workspace.

use super::{projects_persistence, Project};
use crate::access::{
    list_project_catalog_access, list_user_identities, IdentityLookupError, ProjectCatalogAccess,
};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub(super) enum ListProjectsError {
    #[error("project catalog access lookup failed")]
    CatalogAccess(#[source] sqlx::Error),
    #[error("project catalog query failed")]
    Persistence(#[source] sqlx::Error),
    #[error("project thumbnail catalog query failed")]
    ThumbnailCatalog(#[source] sqlx::Error),
    #[error(transparent)]
    Identity(#[from] IdentityLookupError),
    #[error("project catalog access is missing for project {project_id}")]
    CatalogAccessMissing { project_id: Uuid },
}

pub(crate) async fn list_projects(
    db: &PgPool,
    actor_user_id: Uuid,
    include_archived: bool,
    search: Option<&str>,
) -> Result<Vec<Project>, ListProjectsError> {
    let catalog_access = list_project_catalog_access(db, actor_user_id)
        .await
        .map_err(ListProjectsError::CatalogAccess)?;
    let project_ids = catalog_access
        .iter()
        .map(ProjectCatalogAccess::project_id)
        .collect::<Vec<_>>();
    let mut access_by_project = catalog_access
        .into_iter()
        .map(|access| (access.project_id(), access))
        .collect::<HashMap<_, _>>();
    let search_pattern = search
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let records = projects_persistence::list_for_user(
        db,
        actor_user_id,
        &project_ids,
        include_archived,
        search_pattern.as_deref(),
    )
    .await
    .map_err(ListProjectsError::Persistence)?;
    let record_ids = records.iter().map(|record| record.id).collect::<Vec<_>>();
    let thumbnail_project_ids = super::project_ids_with_thumbnails(db, &record_ids)
        .await
        .map_err(ListProjectsError::ThumbnailCatalog)?
        .into_iter()
        .collect::<HashSet<_>>();
    let owner_ids = records
        .iter()
        .filter_map(|record| record.owner_user_id)
        .collect::<Vec<_>>();
    let owner_names = list_user_identities(db, &owner_ids)
        .await?
        .into_iter()
        .map(|user| (user.id, user.display_name))
        .collect::<HashMap<_, _>>();

    records
        .into_iter()
        .map(|record| {
            let project_id = record.id;
            let owner_display_name = record
                .owner_user_id
                .and_then(|owner_user_id| owner_names.get(&owner_user_id).cloned())
                .unwrap_or_else(|| "Unknown".to_string());
            let access = access_by_project
                .remove(&project_id)
                .ok_or(ListProjectsError::CatalogAccessMissing { project_id })?;
            if access.permits_catalog_entry(record.is_template) {
                let has_thumbnail = thumbnail_project_ids.contains(&project_id);
                Ok(Some(project_from_record(
                    record,
                    access,
                    owner_display_name,
                    has_thumbnail,
                )))
            } else {
                Ok(None)
            }
        })
        .filter_map(Result::transpose)
        .collect()
}

fn project_from_record(
    record: projects_persistence::ProjectListRecord,
    access: ProjectCatalogAccess,
    owner_display_name: String,
    has_thumbnail: bool,
) -> Project {
    Project {
        id: record.id,
        name: record.name,
        project_type: record.project_type,
        latex_engine: record.latex_engine,
        owner_user_id: record.owner_user_id,
        owner_display_name,
        my_role: access.effective_role(),
        can_read: access.can_read(),
        is_template: record.is_template,
        has_thumbnail,
        created_at: record.created_at,
        last_edited_at: record.last_edited_at,
        archived: record.archived_at.is_some(),
        archived_at: record.archived_at,
    }
}
