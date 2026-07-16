use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RealtimeMetadataPayload {
    pub user_name: String,
    pub can_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RealtimeCursorPayload {
    pub line: u32,
    pub column: u32,
    pub user_name: String,
    pub can_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind")]
pub enum RealtimeClientMessage {
    #[serde(rename = "yjs.update")]
    YjsUpdate {
        origin: String,
        request_id: String,
        payload: String,
    },
    #[serde(rename = "yjs.sync")]
    YjsSync {
        origin: String,
        request_id: String,
        payload: String,
    },
    #[serde(rename = "presence.meta")]
    PresenceMetadata {
        origin: String,
        payload: RealtimeMetadataPayload,
    },
    #[serde(rename = "presence.cursor")]
    PresenceCursor {
        origin: String,
        payload: RealtimeCursorPayload,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RealtimeServerEvent {
    pub doc_id: String,
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<uuid::Uuid>,
    pub is_current_connection: bool,
    pub kind: RealtimeServerEventKind,
    pub payload: serde_json::Value,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeWorkspaceChangeScope {
    Document,
    Tree,
    Settings,
    Assets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RealtimeWorkspaceChangedPayload {
    pub scope: RealtimeWorkspaceChangeScope,
    #[schema(required)]
    pub path: Option<String>,
    #[schema(required)]
    pub document_id: Option<uuid::Uuid>,
    #[schema(required)]
    pub collaboration_revision: Option<i64>,
    #[schema(required)]
    pub change_sequence: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum RealtimeServerEventKind {
    #[serde(rename = "yjs.update")]
    YjsUpdate,
    #[serde(rename = "yjs.sync")]
    YjsSync,
    #[serde(rename = "yjs.ack")]
    YjsAck,
    #[serde(rename = "presence.join")]
    PresenceJoin,
    #[serde(rename = "presence.leave")]
    PresenceLeave,
    #[serde(rename = "presence.meta")]
    PresenceMetadata,
    #[serde(rename = "presence.cursor")]
    PresenceCursor,
    #[serde(rename = "bootstrap.done")]
    BootstrapDone,
    #[serde(rename = "workspace.changed")]
    WorkspaceChanged,
    #[serde(rename = "document.changed")]
    DocumentChanged,
    #[serde(rename = "project.replaced")]
    ProjectReplaced,
    #[serde(rename = "access.changed")]
    AccessChanged,
    #[serde(rename = "server.error")]
    ServerError,
}

impl RealtimeServerEventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::YjsUpdate => "yjs.update",
            Self::YjsSync => "yjs.sync",
            Self::YjsAck => "yjs.ack",
            Self::PresenceJoin => "presence.join",
            Self::PresenceLeave => "presence.leave",
            Self::PresenceMetadata => "presence.meta",
            Self::PresenceCursor => "presence.cursor",
            Self::BootstrapDone => "bootstrap.done",
            Self::WorkspaceChanged => "workspace.changed",
            Self::DocumentChanged => "document.changed",
            Self::ProjectReplaced => "project.replaced",
            Self::AccessChanged => "access.changed",
            Self::ServerError => "server.error",
        }
    }
}
