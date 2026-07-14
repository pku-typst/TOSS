use super::content::{
    CreateProjectGraph, ProjectContentAsset, ProjectContentSnapshot, ReplaceProjectContent,
    ReplaceProjectContentResult, ReplacedProjectContent,
};
use super::settings_persistence;
use super::ProjectType;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

pub(crate) async fn create_project_graph(
    connection: &mut PgConnection,
    project: &CreateProjectGraph<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into projects (
             id, owner_user_id, name, description, created_at, project_type
         ) values ($1, $2, $3, null, $4, $5)",
    )
    .bind(project.project_id)
    .bind(project.owner_user_id)
    .bind(project.name.as_str())
    .bind(project.created_at)
    .bind(project.project_type)
    .execute(&mut *connection)
    .await?;
    settings_persistence::insert(
        &mut *connection,
        project.project_id,
        project.entry_file_path,
        project.latex_engine,
        project.created_at,
    )
    .await?;
    for directory in project.directories {
        sqlx::query(
            "insert into project_directories (project_id, path, created_at)
             values ($1, $2, $3)",
        )
        .bind(project.project_id)
        .bind(directory)
        .bind(project.created_at)
        .execute(&mut *connection)
        .await?;
    }
    for document in project.documents {
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(project.project_id)
        .bind(&document.path)
        .bind(&document.content)
        .bind(project.created_at)
        .execute(&mut *connection)
        .await?;
    }
    for asset in project.assets {
        sqlx::query(
            "insert into project_assets (
                 id, project_id, path, content_revision, object_key, content_type,
                 size_bytes, uploaded_by, created_at, inline_data
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(asset.id)
        .bind(project.project_id)
        .bind(&asset.path)
        .bind(asset.id)
        .bind(&asset.object_key)
        .bind(&asset.content_type)
        .bind(asset.size_bytes)
        .bind(project.owner_user_id)
        .bind(project.created_at)
        .bind(asset.inline_data.as_deref())
        .execute(&mut *connection)
        .await?;
    }
    Ok(())
}

pub(crate) async fn advance_workspace_version(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update projects
         set workspace_version = workspace_version + 1
         where id = $1",
    )
    .bind(project_id)
    .execute(connection)
    .await?;
    Ok(())
}

pub(crate) async fn lock_workspace_version(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("select workspace_version from projects where id = $1 for update")
        .bind(project_id)
        .fetch_optional(connection)
        .await
}

pub(crate) async fn project_workspace_version(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar::<_, i64>("select workspace_version from projects where id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
}

pub(crate) async fn replace_project_content(
    connection: &mut PgConnection,
    content: &ReplaceProjectContent<'_>,
) -> Result<ReplaceProjectContentResult, sqlx::Error> {
    // Collaboration writes hold a KEY SHARE generation lock. Keep this as FOR UPDATE so a
    // replacement cannot advance content_epoch until every admitted old-generation write ends.
    let project = sqlx::query_as::<_, (i64, ProjectType)>(
        "select workspace_version, project_type from projects where id = $1 for update",
    )
    .bind(content.project_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some((workspace_version, project_type)) = project else {
        return Ok(ReplaceProjectContentResult::NotFound);
    };
    if content
        .expected_workspace_version
        .is_some_and(|expected| expected != workspace_version)
    {
        return Ok(ReplaceProjectContentResult::WorkspaceVersionChanged);
    }
    if !project_type.accepts_entry_file_path(content.entry_file_path)
        || !content
            .documents
            .iter()
            .any(|document| document.path == content.entry_file_path)
    {
        return Ok(ReplaceProjectContentResult::InvalidEntryFile);
    }
    settings_persistence::ensure(
        connection,
        content.project_id,
        project_type.default_entry_file_path(),
        project_type.default_latex_engine(),
        content.updated_at,
    )
    .await?;

    let old_object_keys = sqlx::query_scalar::<_, String>(
        "select object_key from project_assets where project_id = $1 for update",
    )
    .bind(content.project_id)
    .fetch_all(&mut *connection)
    .await?
    .into_iter()
    .filter(|object_key| !object_key.starts_with("inline://"))
    .collect();
    sqlx::query("delete from documents where project_id = $1")
        .bind(content.project_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query("delete from project_assets where project_id = $1")
        .bind(content.project_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query("delete from project_directories where project_id = $1")
        .bind(content.project_id)
        .execute(&mut *connection)
        .await?;

    for document in content.documents {
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(content.project_id)
        .bind(&document.path)
        .bind(&document.content)
        .bind(content.updated_at)
        .execute(&mut *connection)
        .await?;
    }
    for asset in content.assets {
        sqlx::query(
            "insert into project_assets (
                 id, project_id, path, content_revision, object_key, content_type,
                 size_bytes, uploaded_by, created_at, inline_data
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(asset.id)
        .bind(content.project_id)
        .bind(&asset.path)
        .bind(asset.id)
        .bind(&asset.object_key)
        .bind(&asset.content_type)
        .bind(asset.size_bytes)
        .bind(content.asset_uploaded_by)
        .bind(content.updated_at)
        .bind(asset.inline_data.as_deref())
        .execute(&mut *connection)
        .await?;
    }
    for directory in content.directories {
        sqlx::query(
            "insert into project_directories (project_id, path, created_at)
             values ($1, $2, $3)",
        )
        .bind(content.project_id)
        .bind(directory)
        .bind(content.updated_at)
        .execute(&mut *connection)
        .await?;
    }
    settings_persistence::update_entry_file_path(
        connection,
        content.project_id,
        content.entry_file_path,
        content.updated_at,
    )
    .await?;
    let (workspace_version, content_epoch) = sqlx::query_as::<_, (i64, i64)>(
        "update projects
         set workspace_version = workspace_version + 1,
             content_epoch = content_epoch + 1
         where id = $1
         returning workspace_version, content_epoch",
    )
    .bind(content.project_id)
    .fetch_one(connection)
    .await?;
    Ok(ReplaceProjectContentResult::Replaced(
        ReplacedProjectContent {
            old_object_keys,
            workspace_version,
            content_epoch,
        },
    ))
}

pub(super) async fn lock_project_content_snapshot(
    connection: &mut PgConnection,
    project_id: Uuid,
) -> Result<Option<ProjectContentSnapshot>, sqlx::Error> {
    let workspace_version = sqlx::query_scalar::<_, i64>(
        "select workspace_version from projects where id = $1 for share",
    )
    .bind(project_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(workspace_version) = workspace_version else {
        return Ok(None);
    };
    let documents = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(&mut *connection)
        .await?;
    let directories = sqlx::query_scalar::<_, String>(
        "select path from project_directories where project_id = $1 order by path asc",
    )
    .bind(project_id)
    .fetch_all(&mut *connection)
    .await?;
    let assets = sqlx::query(
        "select path, object_key, content_type, inline_data
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(connection)
    .await?;
    let documents = documents
        .into_iter()
        .map(|row| (row.get("path"), row.get("content")))
        .collect();
    let assets = assets
        .into_iter()
        .map(|row| {
            (
                row.get("path"),
                ProjectContentAsset {
                    object_key: row.get("object_key"),
                    content_type: row.get("content_type"),
                    inline_data: row.get("inline_data"),
                },
            )
        })
        .collect();
    Ok(Some(ProjectContentSnapshot {
        workspace_version,
        documents,
        assets,
        directories,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{ReplaceProjectContent, WorkspaceDocument};
    use chrono::Utc;
    use sqlx::PgPool;

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
    async fn replacement_rejects_a_stale_workspace_version(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let now = Utc::now();
        let mut transaction = pool.begin().await?;
        let username_suffix = user_id
            .simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        sqlx::query(
            "insert into users (id, email, username, display_name, created_at)
             values ($1, $2, $3, 'Owner', $4)",
        )
        .bind(user_id)
        .bind(format!("{user_id}@example.test"))
        .bind(format!("user-{username_suffix}"))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "insert into projects (id, owner_user_id, name, created_at, project_type)
             values ($1, $2, 'Workspace CAS test', $3, 'typst')",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let initial_documents = vec![WorkspaceDocument {
            path: "main.typ".to_string(),
            content: "initial".to_string(),
        }];
        let initial = replace_project_content(
            &mut transaction,
            &ReplaceProjectContent {
                project_id,
                expected_workspace_version: Some(0),
                documents: &initial_documents,
                assets: &[],
                directories: &[],
                entry_file_path: "main.typ",
                asset_uploaded_by: None,
                updated_at: now,
            },
        )
        .await?;
        assert!(matches!(initial, ReplaceProjectContentResult::Replaced(_)));

        let invalid_documents = vec![WorkspaceDocument {
            path: "README.md".to_string(),
            content: "missing entry".to_string(),
        }];
        let invalid = replace_project_content(
            &mut transaction,
            &ReplaceProjectContent {
                project_id,
                expected_workspace_version: Some(1),
                documents: &invalid_documents,
                assets: &[],
                directories: &[],
                entry_file_path: "main.typ",
                asset_uploaded_by: None,
                updated_at: now,
            },
        )
        .await?;
        assert!(matches!(
            invalid,
            ReplaceProjectContentResult::InvalidEntryFile
        ));

        let stale_documents = vec![WorkspaceDocument {
            path: "main.typ".to_string(),
            content: "stale overwrite".to_string(),
        }];
        let stale = replace_project_content(
            &mut transaction,
            &ReplaceProjectContent {
                project_id,
                expected_workspace_version: Some(0),
                documents: &stale_documents,
                assets: &[],
                directories: &[],
                entry_file_path: "main.typ",
                asset_uploaded_by: None,
                updated_at: now,
            },
        )
        .await?;
        assert!(matches!(
            stale,
            ReplaceProjectContentResult::WorkspaceVersionChanged
        ));
        let stored_content = sqlx::query_scalar::<_, String>(
            "select content from documents where project_id = $1 and path = 'main.typ'",
        )
        .bind(project_id)
        .fetch_one(&mut *transaction)
        .await?;
        assert_eq!(stored_content, "initial");
        transaction.rollback().await?;
        Ok(())
    }
}
