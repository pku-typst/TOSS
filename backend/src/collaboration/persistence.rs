use super::CollaborationDocument;
use chrono::Utc;
use sqlx::{PgConnection, PgPool, Row};
use std::collections::HashSet;
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PersistedUpdateKind {
    Update,
    Sync,
}

impl PersistedUpdateKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Update => "yjs.update",
            Self::Sync => "yjs.sync",
        }
    }
}

#[derive(Debug)]
pub(super) struct BootstrapState {
    pub upto_update_id: i64,
    pub snapshot_payload: Option<Vec<u8>>,
    pub updates: Vec<(PersistedUpdateKind, Vec<u8>)>,
    pub contributors: Vec<PersistedUpdateContributor>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) enum PersistedUpdateContributor {
    User(Uuid),
    Guest(String),
}

pub(super) struct CollaborationUpdateWrite<'update> {
    pub document: CollaborationDocument,
    pub user_id: Option<Uuid>,
    pub kind: PersistedUpdateKind,
    pub payload: &'update [u8],
    pub guest_display_name: Option<&'update str>,
}

#[derive(Clone)]
pub(super) struct CollaborationPersistence {
    db: PgPool,
    update_retention: i64,
}

impl CollaborationPersistence {
    pub fn new(db: PgPool) -> Self {
        Self {
            db,
            update_retention: configured_limit("COLLAB_DOC_UPDATE_RETAIN", 100, 4000),
        }
    }

    pub async fn clear_project(
        connection: &mut PgConnection,
        project_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("delete from collab_doc_updates where project_id = $1")
            .bind(project_id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("delete from collab_doc_latest_snapshots where project_id = $1")
            .bind(project_id)
            .execute(connection)
            .await?;
        Ok(())
    }

    pub async fn clear_superseded_document_revisions(
        connection: &mut PgConnection,
        document: CollaborationDocument,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "delete from collab_doc_updates
             where project_id = $1
               and document_id = $2
               and collaboration_revision <> $3",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "delete from collab_doc_latest_snapshots
             where project_id = $1
               and document_id = $2
               and collaboration_revision <> $3",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .execute(connection)
        .await?;
        Ok(())
    }

    pub async fn clear_document_revision(
        connection: &mut PgConnection,
        document: CollaborationDocument,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "delete from collab_doc_updates
             where project_id = $1
               and document_id = $2
               and collaboration_revision = $3",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "delete from collab_doc_latest_snapshots
             where project_id = $1
               and document_id = $2
               and collaboration_revision = $3",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .execute(connection)
        .await?;
        Ok(())
    }

    pub async fn lock_document_updates(
        connection: &mut PgConnection,
        document_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))")
            .bind(document_id)
            .execute(connection)
            .await?;
        Ok(())
    }

    pub async fn insert_update(
        &self,
        connection: &mut PgConnection,
        update: &CollaborationUpdateWrite<'_>,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "insert into collab_doc_updates (
                 project_id, document_id, collaboration_revision, user_id,
                 kind, payload, created_at, content_epoch, guest_display_name
             )
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning id",
        )
        .bind(update.document.project_id)
        .bind(update.document.document_id)
        .bind(update.document.collaboration_revision)
        .bind(update.user_id)
        .bind(update.kind.as_str())
        .bind(update.payload)
        .bind(Utc::now())
        .bind(update.document.content_epoch)
        .bind(update.guest_display_name)
        .fetch_one(connection)
        .await
    }

    pub async fn upsert_snapshot(
        &self,
        connection: &mut PgConnection,
        document: CollaborationDocument,
        upto_update_id: i64,
        state_update: &[u8],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into collab_doc_latest_snapshots (
                 project_id, document_id, collaboration_revision, upto_update_id,
                 state_update, updated_at, content_epoch
             ) values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (project_id, document_id, collaboration_revision)
             do update set
               upto_update_id = excluded.upto_update_id,
               state_update = excluded.state_update,
               updated_at = excluded.updated_at,
               content_epoch = excluded.content_epoch
             where collab_doc_latest_snapshots.content_epoch < excluded.content_epoch
                or (
                  collab_doc_latest_snapshots.content_epoch = excluded.content_epoch
                  and collab_doc_latest_snapshots.upto_update_id <= excluded.upto_update_id
                )",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .bind(upto_update_id)
        .bind(state_update)
        .bind(Utc::now())
        .bind(document.content_epoch)
        .execute(connection)
        .await?;
        Ok(())
    }

    pub async fn prune_updates(
        &self,
        connection: &mut PgConnection,
        document: CollaborationDocument,
        latest_update_id: i64,
    ) -> Result<(), sqlx::Error> {
        let cutoff = latest_update_id.saturating_sub(self.update_retention);
        if cutoff <= 0 {
            return Ok(());
        }
        sqlx::query(
            "delete from collab_doc_updates u
             where u.project_id = $1
               and u.document_id = $2
               and u.collaboration_revision = $3
               and u.content_epoch = $5
               and u.id < $4
               and exists (
                 select 1
                 from collab_doc_latest_snapshots s
                 where s.project_id = $1
                   and s.document_id = $2
                   and s.collaboration_revision = $3
                   and s.content_epoch = $5
                   and s.upto_update_id >= $4
               )",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .bind(cutoff)
        .bind(document.content_epoch)
        .execute(connection)
        .await?;
        Ok(())
    }

    pub async fn load_state(
        connection: &mut PgConnection,
        document: CollaborationDocument,
    ) -> Result<BootstrapState, sqlx::Error> {
        let mut snapshot_payload = None;
        let mut snapshot_upto_update_id = 0_i64;
        let snapshot_row = sqlx::query(
            "select upto_update_id, state_update
             from collab_doc_latest_snapshots
             where project_id = $1
               and document_id = $2
               and collaboration_revision = $3
               and content_epoch = $4",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .bind(document.content_epoch)
        .fetch_optional(&mut *connection)
        .await?;
        if let Some(row) = snapshot_row {
            snapshot_upto_update_id = row.get("upto_update_id");
            snapshot_payload = Some(row.get("state_update"));
        }
        let rows = sqlx::query(
            "select id, kind, payload, user_id, guest_display_name
             from collab_doc_updates
             where project_id = $1
               and document_id = $2
               and collaboration_revision = $3
               and content_epoch = $5
               and id > $4
             order by id asc",
        )
        .bind(document.project_id)
        .bind(document.document_id)
        .bind(document.collaboration_revision)
        .bind(snapshot_upto_update_id)
        .bind(document.content_epoch)
        .fetch_all(connection)
        .await?;
        let mut updates = Vec::with_capacity(rows.len());
        let mut contributors = Vec::new();
        let mut seen_contributors = HashSet::new();
        for row in rows {
            snapshot_upto_update_id = row.get("id");
            let kind = match row.get::<String, _>("kind").as_str() {
                "yjs.sync" => PersistedUpdateKind::Sync,
                "yjs.update" => PersistedUpdateKind::Update,
                unexpected => {
                    warn!(
                        kind = unexpected,
                        "ignored unsupported persisted collaboration event"
                    );
                    continue;
                }
            };
            let contributor = row
                .get::<Option<Uuid>, _>("user_id")
                .map(PersistedUpdateContributor::User)
                .or_else(|| {
                    row.get::<Option<String>, _>("guest_display_name")
                        .map(PersistedUpdateContributor::Guest)
                });
            if let Some(contributor) = contributor {
                if seen_contributors.insert(contributor.clone()) {
                    contributors.push(contributor);
                }
            }
            updates.push((kind, row.get("payload")));
        }
        Ok(BootstrapState {
            upto_update_id: snapshot_upto_update_id,
            snapshot_payload,
            updates,
            contributors,
        })
    }

    pub async fn latest_project_update_id(
        &self,
        project_id: Uuid,
    ) -> Result<Option<i64>, sqlx::Error> {
        sqlx::query_scalar("select max(id) from collab_doc_updates where project_id = $1")
            .bind(project_id)
            .fetch_one(&self.db)
            .await
    }

    pub async fn pending_project_documents(
        &self,
        project_id: Uuid,
        upto_update_id: i64,
    ) -> Result<Vec<CollaborationDocument>, sqlx::Error> {
        let rows = sqlx::query(
            "select u.project_id, u.document_id, u.collaboration_revision, u.content_epoch,
                    min(u.id) as first_update_id
             from collab_doc_updates u
             left join collab_doc_latest_snapshots s
               on s.project_id = u.project_id
              and s.document_id = u.document_id
              and s.collaboration_revision = u.collaboration_revision
              and s.content_epoch = u.content_epoch
             where u.project_id = $1
               and u.id <= $2
               and u.id > coalesce(s.upto_update_id, 0)
             group by u.project_id, u.document_id, u.collaboration_revision, u.content_epoch
             order by first_update_id asc",
        )
        .bind(project_id)
        .bind(upto_update_id)
        .fetch_all(&self.db)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| CollaborationDocument {
                project_id: row.get("project_id"),
                document_id: row.get("document_id"),
                collaboration_revision: row.get("collaboration_revision"),
                content_epoch: row.get("content_epoch"),
            })
            .collect())
    }

    pub async fn next_pending_document(
        &self,
    ) -> Result<Option<CollaborationDocument>, sqlx::Error> {
        let row = sqlx::query(
            "select u.project_id, u.document_id, u.collaboration_revision, u.content_epoch
             from collab_doc_updates u
             left join collab_doc_latest_snapshots s
               on s.project_id = u.project_id
              and s.document_id = u.document_id
              and s.collaboration_revision = u.collaboration_revision
              and s.content_epoch = u.content_epoch
             where u.id > coalesce(s.upto_update_id, 0)
             order by u.id asc
             limit 1",
        )
        .fetch_optional(&self.db)
        .await?;
        Ok(row.map(|row| CollaborationDocument {
            project_id: row.get("project_id"),
            document_id: row.get("document_id"),
            collaboration_revision: row.get("collaboration_revision"),
            content_epoch: row.get("content_epoch"),
        }))
    }
}

fn configured_limit(name: &str, minimum: i64, default: i64) -> i64 {
    let configured = std::env::var(name).ok();
    parse_limit(configured.as_deref(), minimum, default)
}

fn parse_limit(value: Option<&str>, minimum: i64, default: i64) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= minimum)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    #[test]
    fn configured_limits_reject_values_below_the_safety_floor() {
        assert_eq!(super::parse_limit(Some("99"), 100, 4000), 4000);
        assert_eq!(super::parse_limit(Some("100"), 100, 4000), 100);
        assert_eq!(super::parse_limit(Some("invalid"), 100, 4000), 4000);
    }
}
