mod bootstrap;
mod persistence;
mod projection;
mod rooms;
mod updates;
mod websocket;
mod yjs_state;

use persistence::CollaborationPersistence;
use rooms::CollaborationRooms;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub(crate) use projection::{
    spawn_collaboration_projection_worker, FlushProjectCollaborationError,
};
pub(crate) use websocket::{project_ws_handler, realtime_auth, ws_handler, RealtimeAuthResponse};

pub(crate) enum WorkspaceChange {
    Document {
        path: String,
        document_id: Uuid,
        collaboration_revision: i64,
        change_sequence: i64,
    },
    Tree {
        path: Option<String>,
    },
    Settings,
    Assets {
        path: Option<String>,
    },
}

#[derive(Clone, Copy, Debug)]
struct CollaborationDocument {
    project_id: Uuid,
    document_id: Uuid,
    collaboration_revision: i64,
    content_epoch: i64,
}

#[derive(Clone)]
pub(crate) struct CollaborationContext {
    db: PgPool,
    persistence: CollaborationPersistence,
    rooms: CollaborationRooms,
}

impl CollaborationContext {
    pub fn new(db: PgPool) -> Self {
        Self {
            persistence: CollaborationPersistence::new(db.clone()),
            db,
            rooms: CollaborationRooms::default(),
        }
    }

    pub async fn invalidate_project(&self, project_id: Uuid, content_epoch: i64) {
        self.rooms
            .invalidate_project(project_id, content_epoch)
            .await;
    }

    pub async fn workspace_changed(&self, project_id: Uuid, change: WorkspaceChange) {
        self.rooms.workspace_changed(project_id, &change).await;
    }

    pub async fn access_changed(&self, project_id: Uuid) {
        self.rooms.access_changed(project_id).await;
    }

    pub async fn clear_persisted_project(
        &self,
        connection: &mut PgConnection,
        project_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        CollaborationPersistence::clear_project(connection, project_id).await
    }
}
