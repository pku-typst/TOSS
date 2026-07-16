//! Built-in template materialization into a new Workspace project.

use crate::access::{user_display_name, IdentityLookupError, ProjectRole};
use crate::distribution::template_catalog::BuiltinTemplate;
use crate::object_cleanup::{cleanup_uncommitted_object, cleanup_uncommitted_objects};
use crate::object_storage::{put_object, ObjectStorage, ObjectStorageError};
use crate::workspace::{
    mark_project_dirty, provision_project, store_project_thumbnail, CreateProjectGraph,
    LatexEngine, Project, ProjectName, ProjectType, WorkspaceAsset, WorkspaceDocument,
};
use chrono::Utc;
use sqlx::PgPool;
use std::collections::HashSet;
use std::path::Path;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum InstantiateBuiltinTemplateStage {
    Begin,
    PersistProjectGraph,
    Commit,
}

#[derive(Debug, Error)]
#[error("built-in template persistence failed during {stage:?} for project {project_id}")]
pub(super) struct InstantiateBuiltinTemplatePersistenceError {
    stage: InstantiateBuiltinTemplateStage,
    project_id: Uuid,
    #[source]
    source: sqlx::Error,
}

impl InstantiateBuiltinTemplatePersistenceError {
    fn new(stage: InstantiateBuiltinTemplateStage, project_id: Uuid, source: sqlx::Error) -> Self {
        Self {
            stage,
            project_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum InstantiateBuiltinTemplateError {
    #[error(transparent)]
    Identity(#[from] IdentityLookupError),
    #[error("built-in template text asset is not valid UTF-8: {path}")]
    InvalidTextAsset { path: String },
    #[error("built-in template asset is too large: {path}")]
    AssetTooLarge { path: String },
    #[error("built-in template asset upload failed for {object_key}")]
    AssetStorage {
        object_key: String,
        #[source]
        source: ObjectStorageError,
    },
    #[error(transparent)]
    Persistence(#[from] InstantiateBuiltinTemplatePersistenceError),
}

pub(crate) async fn instantiate_builtin_template(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    data_dir: &Path,
    actor_user_id: Uuid,
    name: &ProjectName,
    template: &BuiltinTemplate,
) -> Result<Project, InstantiateBuiltinTemplateError> {
    let project_id = Uuid::new_v4();
    let created_at = Utc::now();
    let owner_display_name = user_display_name(db, actor_user_id)
        .await?
        .unwrap_or_else(|| "Unknown".to_string());
    let documents = template
        .files
        .iter()
        .filter(|file| file.is_text)
        .map(|file| {
            std::str::from_utf8(&file.bytes)
                .map(|content| WorkspaceDocument {
                    path: file.path.clone(),
                    content: content.to_string(),
                })
                .map_err(|_| InstantiateBuiltinTemplateError::InvalidTextAsset {
                    path: file.path.clone(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut assets = Vec::new();
    for file in template.files.iter().filter(|file| !file.is_text) {
        let asset_id = Uuid::new_v4();
        let bytes = file.bytes.to_vec();
        let size_bytes = match i64::try_from(bytes.len()) {
            Ok(value) => value,
            Err(_) => {
                cleanup_template_assets(db, storage, &assets).await;
                return Err(InstantiateBuiltinTemplateError::AssetTooLarge {
                    path: file.path.clone(),
                });
            }
        };
        let (object_key, inline_data) = if let Some(storage) = storage {
            let object_key = format!("projects/{project_id}/assets/{asset_id}");
            if let Err(source) = put_object(storage, &object_key, &file.content_type, bytes).await {
                cleanup_uncommitted_object(db, Some(storage), &object_key).await;
                cleanup_template_assets(db, Some(storage), &assets).await;
                return Err(InstantiateBuiltinTemplateError::AssetStorage { object_key, source });
            }
            (object_key, None)
        } else {
            (format!("inline://{asset_id}"), Some(bytes))
        };
        assets.push(WorkspaceAsset {
            id: asset_id,
            path: file.path.clone(),
            object_key,
            content_type: file.content_type.clone(),
            size_bytes,
            inline_data,
        });
    }
    let mut directories = HashSet::new();
    for file in &template.files {
        collect_parent_directories(&file.path, &mut directories);
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    let object_keys = template_object_keys(&assets);
    let latex_engine = (template.project_type == ProjectType::Latex).then_some(LatexEngine::Xetex);
    let mut transaction = match db.begin().await {
        Ok(transaction) => transaction,
        Err(source) => {
            cleanup_uncommitted_objects(db, storage, &object_keys).await;
            return Err(InstantiateBuiltinTemplatePersistenceError::new(
                InstantiateBuiltinTemplateStage::Begin,
                project_id,
                source,
            )
            .into());
        }
    };
    let project = CreateProjectGraph {
        project_id,
        owner_user_id: actor_user_id,
        name,
        project_type: template.project_type,
        entry_file_path: &template.entry_file_path,
        latex_engine,
        directories: &directories,
        documents: &documents,
        assets: &assets,
        created_at,
    };
    let persistence = async {
        provision_project(&mut transaction, &project).await?;
        mark_project_dirty(&mut transaction, project_id, Some(actor_user_id), None).await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if let Err(source) = persistence {
        if let Err(rollback_error) = transaction.rollback().await {
            warn!(%rollback_error, %project_id, "built-in template rollback failed");
        }
        cleanup_uncommitted_objects(db, storage, &object_keys).await;
        return Err(InstantiateBuiltinTemplatePersistenceError::new(
            InstantiateBuiltinTemplateStage::PersistProjectGraph,
            project_id,
            source,
        )
        .into());
    }
    if let Err(source) = transaction.commit().await {
        return Err(InstantiateBuiltinTemplatePersistenceError::new(
            InstantiateBuiltinTemplateStage::Commit,
            project_id,
            source,
        )
        .into());
    }
    let has_thumbnail = if let Some(thumbnail) = template.thumbnail.as_ref() {
        match store_project_thumbnail(
            db,
            data_dir,
            project_id,
            &thumbnail.content_type,
            actor_user_id,
            created_at,
            &thumbnail.bytes,
        )
        .await
        {
            Ok(()) => true,
            Err(error) => {
                warn!(error = ?error, %project_id, "built-in template thumbnail was not stored");
                false
            }
        }
    } else {
        false
    };
    Ok(Project {
        id: project_id,
        name: name.as_str().to_string(),
        project_type: template.project_type,
        latex_engine,
        owner_user_id: Some(actor_user_id),
        owner_display_name,
        my_role: ProjectRole::Owner,
        can_read: true,
        is_template: false,
        has_thumbnail,
        created_at,
        last_edited_at: created_at,
        archived: false,
        archived_at: None,
    })
}

fn collect_parent_directories(path: &str, directories: &mut HashSet<String>) {
    let mut current = String::new();
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(component);
        directories.insert(current.clone());
    }
}

fn template_object_keys(assets: &[WorkspaceAsset]) -> Vec<String> {
    assets
        .iter()
        .map(|asset| asset.object_key.clone())
        .collect()
}

async fn cleanup_template_assets(
    db: &PgPool,
    storage: Option<&ObjectStorage>,
    assets: &[WorkspaceAsset],
) {
    cleanup_uncommitted_objects(db, storage, &template_object_keys(assets)).await;
}

#[cfg(test)]
mod tests {
    use super::collect_parent_directories;
    use std::collections::HashSet;

    #[test]
    fn parent_directory_collection_builds_each_ancestor_once() {
        let mut directories = HashSet::new();
        collect_parent_directories("assets/images/logo.png", &mut directories);
        collect_parent_directories("assets/fonts/body.ttf", &mut directories);
        assert_eq!(directories.len(), 3);
        assert!(directories.contains("assets"));
        assert!(directories.contains("assets/images"));
        assert!(directories.contains("assets/fonts"));
    }
}
