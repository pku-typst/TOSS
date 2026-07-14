//! Project catalog and basic-lifecycle persistence owned by Workspace.

use super::{LatexEngine, ProjectName, ProjectType};
use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct ProjectListRecord {
    pub id: Uuid,
    pub name: String,
    pub project_type: ProjectType,
    pub latex_engine: Option<LatexEngine>,
    pub owner_user_id: Option<Uuid>,
    pub is_template: bool,
    pub created_at: DateTime<Utc>,
    pub last_edited_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
}

impl<'row> FromRow<'row, PgRow> for ProjectListRecord {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            project_type: row.try_get("project_type")?,
            latex_engine: row.try_get("latex_engine")?,
            owner_user_id: row.try_get("owner_user_id")?,
            is_template: row.try_get("is_template")?,
            created_at: row.try_get("created_at")?,
            last_edited_at: row.try_get("last_edited_at")?,
            archived_at: row.try_get("archived_at")?,
        })
    }
}

pub(crate) async fn list_for_user(
    db: &PgPool,
    actor_user_id: Uuid,
    project_ids: &[Uuid],
    include_archived: bool,
    search_pattern: Option<&str>,
) -> Result<Vec<ProjectListRecord>, sqlx::Error> {
    sqlx::query_as::<_, ProjectListRecord>(
        "select p.id,
                p.name,
                p.project_type,
                settings.latex_engine,
                p.owner_user_id,
                p.is_template,
                p.created_at,
                greatest(
                  p.created_at,
                  coalesce(
                    (select max(document.updated_at) from documents document where document.project_id = p.id),
                    p.created_at
                  ),
                  coalesce(
                    (select max(asset.created_at) from project_assets asset where asset.project_id = p.id),
                    p.created_at
                  )
                ) as last_edited_at,
                archive.archived_at
         from projects p
         left join project_settings settings on settings.project_id = p.id
         left join project_user_archives archive
           on archive.project_id = p.id and archive.user_id = $1
         where p.id = any($2)
           and ($3::boolean = true or archive.archived_at is null)
           and ($4::text is null or p.name ilike $4)
         order by last_edited_at desc",
    )
    .bind(actor_user_id)
    .bind(project_ids)
    .bind(include_archived)
    .bind(search_pattern)
    .fetch_all(db)
    .await
}

pub(crate) async fn rename(
    connection: &mut PgConnection,
    project_id: Uuid,
    name: &ProjectName,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query("update projects set name = $2 where id = $1")
        .bind(project_id)
        .bind(name.as_str())
        .execute(connection)
        .await?
        .rows_affected()
        > 0)
}
