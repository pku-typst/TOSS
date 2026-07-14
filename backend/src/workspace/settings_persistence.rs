//! Project-settings persistence owned by the Workspace context.

use super::{LatexEngine, ProjectType};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) struct ProjectSettingsRecord {
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub latex_engine: Option<LatexEngine>,
    pub settings_revision: i64,
    pub updated_at: DateTime<Utc>,
}

pub(crate) struct ProjectEntrySettingsRecord {
    pub project_type: ProjectType,
    pub entry_file_path: Option<String>,
}

pub(crate) async fn find_entry_settings(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<ProjectEntrySettingsRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select projects.project_type, project_settings.entry_file_path
         from projects
         left join project_settings on project_settings.project_id = projects.id
         where projects.id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ProjectEntrySettingsRecord {
        project_type: row.get("project_type"),
        entry_file_path: row.get("entry_file_path"),
    }))
}

pub(crate) async fn find_entry_settings_in_transaction(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<ProjectEntrySettingsRecord>, sqlx::Error> {
    let row = sqlx::query(
        "select projects.project_type, project_settings.entry_file_path
         from projects
         left join project_settings on project_settings.project_id = projects.id
         where projects.id = $1",
    )
    .bind(project_id)
    .fetch_optional(connection)
    .await?;
    Ok(row.map(|row| ProjectEntrySettingsRecord {
        project_type: row.get("project_type"),
        entry_file_path: row.get("entry_file_path"),
    }))
}

pub(crate) async fn find_project_type(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<ProjectType>, sqlx::Error> {
    let row = sqlx::query("select project_type from projects where id = $1")
        .bind(project_id)
        .fetch_optional(connection)
        .await?;
    Ok(row.map(|value| value.get("project_type")))
}

pub(crate) async fn document_exists(
    connection: &mut PgConnection,
    project_id: Uuid,
    path: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(
             select 1 from documents where project_id = $1 and path = $2
         )",
    )
    .bind(project_id)
    .bind(path)
    .fetch_one(connection)
    .await
}

pub(crate) async fn insert(
    connection: &mut PgConnection,
    project_id: Uuid,
    entry_file_path: &str,
    latex_engine: Option<LatexEngine>,
    updated_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into project_settings (project_id, entry_file_path, latex_engine, updated_at)
         values ($1, $2, $3, $4)",
    )
    .bind(project_id)
    .bind(entry_file_path)
    .bind(latex_engine)
    .bind(updated_at)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn ensure(
    connection: &mut PgConnection,
    project_id: Uuid,
    entry_file_path: &str,
    latex_engine: Option<LatexEngine>,
    updated_at: DateTime<Utc>,
) -> Result<ProjectSettingsRecord, sqlx::Error> {
    let row = sqlx::query(
        "insert into project_settings (project_id, entry_file_path, latex_engine, updated_at)
         values ($1, $2, $3, $4)
         on conflict (project_id) do update set project_id = excluded.project_id
         returning project_id, entry_file_path, latex_engine, settings_revision, updated_at",
    )
    .bind(project_id)
    .bind(entry_file_path)
    .bind(latex_engine)
    .bind(updated_at)
    .fetch_one(connection)
    .await?;
    Ok(settings_from_row(&row))
}

pub(crate) async fn update_entry_file_path(
    connection: &mut PgConnection,
    project_id: Uuid,
    entry_file_path: &str,
    updated_at: DateTime<Utc>,
) -> Result<ProjectSettingsRecord, sqlx::Error> {
    let row = sqlx::query(
        "update project_settings
         set entry_file_path = $2,
             settings_revision = settings_revision + 1,
             updated_at = $3
         where project_id = $1
         returning project_id, entry_file_path, latex_engine, settings_revision, updated_at",
    )
    .bind(project_id)
    .bind(entry_file_path)
    .bind(updated_at)
    .fetch_one(connection)
    .await?;
    Ok(settings_from_row(&row))
}

pub(crate) async fn update_latex_engine(
    connection: &mut PgConnection,
    project_id: Uuid,
    latex_engine: LatexEngine,
    updated_at: DateTime<Utc>,
) -> Result<ProjectSettingsRecord, sqlx::Error> {
    let row = sqlx::query(
        "update project_settings
         set latex_engine = $2,
             settings_revision = settings_revision + 1,
             updated_at = $3
         where project_id = $1
         returning project_id, entry_file_path, latex_engine, settings_revision, updated_at",
    )
    .bind(project_id)
    .bind(latex_engine)
    .bind(updated_at)
    .fetch_one(connection)
    .await?;
    Ok(settings_from_row(&row))
}

fn settings_from_row(row: &sqlx::postgres::PgRow) -> ProjectSettingsRecord {
    ProjectSettingsRecord {
        project_id: row.get("project_id"),
        entry_file_path: row.get("entry_file_path"),
        latex_engine: row.get("latex_engine"),
        settings_revision: row.get("settings_revision"),
        updated_at: row.get("updated_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn migrated_test_pool() -> Result<Option<PgPool>, Box<dyn std::error::Error + Send + Sync>>
    {
        let database_url =
            std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"));
        let Ok(database_url) = database_url else {
            return Ok(None);
        };
        let pool = PgPool::connect(&database_url).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Some(pool))
    }

    #[tokio::test]
    async fn concurrent_semantic_setting_updates_preserve_each_other(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let now = Utc::now();
        let mut setup = pool.begin().await?;
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Settings field isolation', $2, 'latex')",
        )
        .bind(project_id)
        .bind(now)
        .execute(&mut *setup)
        .await?;
        insert(
            &mut setup,
            project_id,
            "main.tex",
            Some(LatexEngine::Xetex),
            now,
        )
        .await?;
        setup.commit().await?;

        let update_entry = async {
            let mut transaction = pool.begin().await?;
            let updated =
                update_entry_file_path(&mut transaction, project_id, "slides.tex", now).await?;
            transaction.commit().await?;
            Ok::<_, sqlx::Error>(updated)
        };
        let update_engine = async {
            let mut transaction = pool.begin().await?;
            let updated =
                update_latex_engine(&mut transaction, project_id, LatexEngine::Pdftex, now).await?;
            transaction.commit().await?;
            Ok::<_, sqlx::Error>(updated)
        };
        let (entry_updated, engine_updated) = tokio::try_join!(update_entry, update_engine)?;
        assert_eq!(entry_updated.entry_file_path, "slides.tex");
        assert_eq!(engine_updated.latex_engine, Some(LatexEngine::Pdftex));

        let mut transaction = pool.begin().await?;
        let settings = ensure(
            &mut transaction,
            project_id,
            "unused.tex",
            Some(LatexEngine::Xetex),
            now,
        )
        .await?;
        transaction.rollback().await?;
        assert_eq!(settings.entry_file_path, "slides.tex");
        assert_eq!(settings.latex_engine, Some(LatexEngine::Pdftex));
        assert_eq!(settings.settings_revision, 2);

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
