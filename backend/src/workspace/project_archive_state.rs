//! Per-user Workspace project archive state.

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn set_project_archived(
    db: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
    archived: bool,
) -> Result<(), sqlx::Error> {
    if archived {
        sqlx::query(
            "insert into project_user_archives (project_id, user_id, archived_at)
             values ($1, $2, $3)
             on conflict (project_id, user_id)
             do update set archived_at = excluded.archived_at",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(Utc::now())
        .execute(db)
        .await?;
    } else {
        sqlx::query("delete from project_user_archives where project_id = $1 and user_id = $2")
            .bind(project_id)
            .bind(user_id)
            .execute(db)
            .await?;
    }
    Ok(())
}
