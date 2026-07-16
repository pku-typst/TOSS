//! File-tree persistence owned by the Workspace context.

use super::assets_persistence::{
    delete_subtree as delete_asset_subtree,
    lock_object_keys_in_subtree as lock_asset_object_keys_in_subtree,
    move_subtree as move_asset_subtree,
};
use super::ProjectType;
use crate::database_error::is_unique_constraint_violation;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) fn is_project_path_conflict(error: &sqlx::Error) -> bool {
    [
        "documents_project_id_path_key",
        "project_directories_pkey",
        "uniq_project_assets_path",
    ]
    .into_iter()
    .any(|constraint| is_unique_constraint_violation(error, constraint))
}

pub(crate) struct FileMutationCounts {
    pub directories: u64,
    pub documents: u64,
    pub assets: u64,
}

impl FileMutationCounts {
    pub fn changed(&self) -> bool {
        self.directories > 0 || self.documents > 0 || self.assets > 0
    }
}

pub(crate) async fn insert_directory(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
    created_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "insert into project_directories (project_id, path, created_at)
         values ($1, $2, $3)
         on conflict (project_id, path) do nothing",
    )
    .bind(project_id)
    .bind(path)
    .bind(created_at)
    .execute(connection)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn upsert_document(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
    content: &str,
    updated_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, path) do update
         set content = excluded.content,
             updated_at = excluded.updated_at,
             collaboration_revision = documents.collaboration_revision + 1,
             change_sequence = nextval('documents_change_sequence_seq')",
    )
    .bind(Uuid::new_v4())
    .bind(project_id)
    .bind(path)
    .bind(content)
    .bind(updated_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn delete_document_at_path(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<u64, sqlx::Error> {
    Ok(
        sqlx::query("delete from documents where project_id = $1 and path = $2")
            .bind(project_id)
            .bind(path)
            .execute(connection)
            .await?
            .rows_affected(),
    )
}

pub(crate) async fn move_subtree(
    connection: &mut PgConnection,
    project_id: Uuid,
    from_path: &str,
    to_path: &str,
    updated_at: DateTime<Utc>,
) -> Result<FileMutationCounts, sqlx::Error> {
    let directories = sqlx::query(
        "update project_directories
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(from_path)
    .bind(to_path)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    let documents = sqlx::query(
        "update documents
         set path = case
             when path = $2 then $3
             else $3 || substring(path from char_length($2) + 1)
         end,
         path_revision = path_revision + 1,
         change_sequence = nextval('documents_change_sequence_seq'),
         updated_at = $4
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(from_path)
    .bind(to_path)
    .bind(updated_at)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    let asset_count = move_asset_subtree(connection, project_id, from_path, to_path).await?;
    Ok(FileMutationCounts {
        directories,
        documents,
        assets: asset_count,
    })
}

pub(crate) struct DeletedSubtree {
    pub counts: FileMutationCounts,
    pub object_keys: Vec<String>,
}

pub(crate) async fn delete_subtree(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<DeletedSubtree, sqlx::Error> {
    let object_keys = lock_asset_object_keys_in_subtree(connection, project_id, path).await?;
    let directories = sqlx::query(
        "delete from project_directories
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(path)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    let documents = sqlx::query(
        "delete from documents
         where project_id = $1
           and (path = $2 or left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(project_id)
    .bind(path)
    .execute(&mut *connection)
    .await?
    .rows_affected();
    let asset_count = delete_asset_subtree(connection, project_id, path).await?;
    Ok(DeletedSubtree {
        counts: FileMutationCounts {
            directories,
            documents,
            assets: asset_count,
        },
        object_keys,
    })
}

pub(crate) struct ProjectTreeRecord {
    pub document_paths: Vec<String>,
    pub directory_paths: Vec<String>,
    pub asset_paths: Vec<String>,
    pub entry_file_path: Option<String>,
    pub project_type: ProjectType,
    pub content_epoch: i64,
}

pub(crate) async fn load_tree(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ProjectTreeRecord>, sqlx::Error> {
    let project = sqlx::query(
        "select p.project_type, p.content_epoch, settings.entry_file_path
         from projects p
         left join project_settings settings on settings.project_id = p.id
         where p.id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let Some(project) = project else {
        return Ok(None);
    };
    let (document_rows, directory_rows, asset_rows) = tokio::try_join!(
        sqlx::query("select path from documents where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(db),
        sqlx::query(
            "select path from project_directories where project_id = $1 order by path asc",
        )
        .bind(project_id)
        .fetch_all(db),
        sqlx::query("select path from project_assets where project_id = $1 order by path asc")
            .bind(project_id)
            .fetch_all(db),
    )?;
    Ok(Some(ProjectTreeRecord {
        document_paths: document_rows
            .into_iter()
            .map(|row| row.get("path"))
            .collect(),
        directory_paths: directory_rows
            .into_iter()
            .map(|row| row.get("path"))
            .collect(),
        asset_paths: asset_rows.into_iter().map(|row| row.get("path")).collect(),
        entry_file_path: project.get("entry_file_path"),
        project_type: project.get("project_type"),
        content_epoch: project.get("content_epoch"),
    }))
}
