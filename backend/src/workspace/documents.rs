//! Workspace document read contract and queries.

use super::documents_persistence::{self, DocumentRecord};
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use thiserror::Error;
use uuid::Uuid;

const DOCUMENT_PAGE_SIZE: usize = 500;

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct Document {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub path_revision: i64,
    pub collaboration_revision: i64,
    pub change_sequence: i64,
    pub content: String,
    pub updated_at: DateTime<Utc>,
}

pub(super) enum DocumentListFilter {
    Path(String),
    AfterChangeSequence(Option<i64>),
}

pub(super) struct DocumentPage {
    pub documents: Vec<Document>,
    pub cursor: Option<i64>,
    pub has_more: bool,
}

#[derive(Clone, Copy, Debug)]
enum DocumentQuery {
    List,
    Find,
}

#[derive(Debug, Error)]
#[error("document query {query:?} failed for project {project_id} and document {document_id:?}")]
pub(super) struct DocumentQueryError {
    query: DocumentQuery,
    project_id: Uuid,
    document_id: Option<Uuid>,
    #[source]
    source: sqlx::Error,
}

impl DocumentQueryError {
    fn new(
        query: DocumentQuery,
        project_id: Uuid,
        document_id: Option<Uuid>,
        source: sqlx::Error,
    ) -> Self {
        Self {
            query,
            project_id,
            document_id,
            source,
        }
    }
}

#[derive(Debug, Error)]
pub(super) enum GetDocumentError {
    #[error("document was not found")]
    DocumentNotFound,
    #[error(transparent)]
    Query(#[from] DocumentQueryError),
}

pub(super) async fn list_documents(
    db: &PgPool,
    project_id: Uuid,
    filter: DocumentListFilter,
) -> Result<DocumentPage, DocumentQueryError> {
    let (records, paginated) = match filter {
        DocumentListFilter::Path(path) => (
            documents_persistence::list_by_path(db, project_id, &path).await,
            false,
        ),
        DocumentListFilter::AfterChangeSequence(cursor) => (
            documents_persistence::list_after_change_sequence(
                db,
                project_id,
                cursor,
                i64::try_from(DOCUMENT_PAGE_SIZE + 1).unwrap_or(i64::MAX),
            )
            .await,
            true,
        ),
    };
    let mut records = records
        .map_err(|source| DocumentQueryError::new(DocumentQuery::List, project_id, None, source))?;
    let has_more = paginated && records.len() > DOCUMENT_PAGE_SIZE;
    if has_more {
        records.truncate(DOCUMENT_PAGE_SIZE);
    }
    let cursor = records.last().map(|record| record.change_sequence);

    Ok(DocumentPage {
        documents: records.into_iter().map(document_from_record).collect(),
        cursor,
        has_more,
    })
}

pub(super) async fn get_document(
    db: &PgPool,
    project_id: Uuid,
    document_id: Uuid,
) -> Result<Document, GetDocumentError> {
    documents_persistence::find_by_id(db, project_id, document_id)
        .await
        .map_err(|source| {
            DocumentQueryError::new(DocumentQuery::Find, project_id, Some(document_id), source)
        })?
        .map(document_from_record)
        .ok_or(GetDocumentError::DocumentNotFound)
}

pub(crate) async fn document_collaboration_revision_matches(
    db: &PgPool,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<bool, DocumentIdentityQueryError> {
    documents_persistence::collaboration_revision_matches(
        db,
        project_id,
        document_id,
        collaboration_revision,
    )
    .await
    .map_err(|source| DocumentIdentityQueryError {
        project_id,
        document_id,
        source,
    })
}

pub(crate) async fn document_collaboration_seed(
    connection: &mut PgConnection,
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<Option<String>, DocumentIdentityQueryError> {
    documents_persistence::collaboration_seed_content(
        connection,
        project_id,
        document_id,
        collaboration_revision,
    )
    .await
    .map_err(|source| DocumentIdentityQueryError {
        project_id,
        document_id,
        source,
    })
}

#[derive(Debug, Error)]
#[error("document identity query failed for project {project_id} and document {document_id}")]
pub(crate) struct DocumentIdentityQueryError {
    project_id: Uuid,
    document_id: Uuid,
    #[source]
    source: sqlx::Error,
}

pub(super) fn document_from_record(record: DocumentRecord) -> Document {
    Document {
        id: record.id,
        project_id: record.project_id,
        path: record.path,
        path_revision: record.path_revision,
        collaboration_revision: record.collaboration_revision,
        change_sequence: record.change_sequence,
        content: record.content,
        updated_at: record.updated_at,
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
    async fn change_sequence_pagination_does_not_truncate_large_deltas(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(pool) = migrated_test_pool().await? else {
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        sqlx::query(
            "insert into projects (id, name, created_at, project_type)
             values ($1, 'Document pagination test', $2, 'typst')",
        )
        .bind(project_id)
        .bind(Utc::now())
        .execute(&pool)
        .await?;
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             select uuid_generate_v4(), $1, 'page-' || series || '.typ', '', $2
             from generate_series(1, 501) as series",
        )
        .bind(project_id)
        .bind(Utc::now())
        .execute(&pool)
        .await?;

        let first = list_documents(
            &pool,
            project_id,
            DocumentListFilter::AfterChangeSequence(None),
        )
        .await?;
        assert_eq!(first.documents.len(), DOCUMENT_PAGE_SIZE);
        assert!(first.has_more);
        let Some(cursor) = first.cursor else {
            return Err("first document page did not provide a cursor".into());
        };
        let second = list_documents(
            &pool,
            project_id,
            DocumentListFilter::AfterChangeSequence(Some(cursor)),
        )
        .await?;
        assert_eq!(second.documents.len(), 1);
        assert!(!second.has_more);
        assert!(second.cursor.is_some_and(|next| next > cursor));

        sqlx::query("delete from projects where id = $1")
            .bind(project_id)
            .execute(&pool)
            .await?;
        Ok(())
    }
}
