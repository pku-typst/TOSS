use super::WorkspaceChange;
use crate::protocol::{RealtimeWorkspaceChangeScope, RealtimeWorkspaceChangedPayload};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

const PROJECT_CONTROL_ROOM: &str = "__project_control__";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RoomEventKind {
    YjsUpdate,
    YjsSync,
    YjsAck,
    PresenceJoin,
    PresenceLeave,
    PresenceMetadata,
    PresenceCursor,
    BootstrapDone,
    WorkspaceChanged,
    DocumentChanged,
    ProjectReplaced,
    AccessChanged,
    ServerError,
}

#[derive(Debug, Clone)]
pub(super) enum RoomEventOrigin {
    System,
    Connection {
        member_id: String,
        connection_id: Uuid,
    },
}

#[derive(Debug, Clone)]
pub(super) struct RoomEvent {
    pub doc_id: String,
    pub origin: RoomEventOrigin,
    pub kind: RoomEventKind,
    pub payload: Value,
    pub at: DateTime<Utc>,
}

impl RoomEvent {
    pub fn system(doc_id: impl Into<String>, kind: RoomEventKind, payload: Value) -> Self {
        Self {
            doc_id: doc_id.into(),
            origin: RoomEventOrigin::System,
            kind,
            payload,
            at: Utc::now(),
        }
    }

    pub fn from_connection(
        doc_id: impl Into<String>,
        member_id: impl Into<String>,
        connection_id: Uuid,
        kind: RoomEventKind,
        payload: Value,
    ) -> Self {
        Self {
            doc_id: doc_id.into(),
            origin: RoomEventOrigin::Connection {
                member_id: member_id.into(),
                connection_id,
            },
            kind,
            payload,
            at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RoomKey {
    project_id: Uuid,
    doc_id: String,
}

#[derive(Clone, Default)]
pub(super) struct CollaborationRooms {
    channels: Arc<RwLock<HashMap<RoomKey, broadcast::Sender<RoomEvent>>>>,
}

pub(super) struct RoomSubscription {
    pub sender: broadcast::Sender<RoomEvent>,
    pub receiver: broadcast::Receiver<RoomEvent>,
}

impl CollaborationRooms {
    pub async fn subscribe(&self, project_id: Uuid, doc_id: &str) -> RoomSubscription {
        let key = RoomKey {
            project_id,
            doc_id: doc_id.to_string(),
        };
        {
            let channels = self.channels.read().await;
            if let Some(sender) = channels.get(&key).cloned() {
                let receiver = sender.subscribe();
                return RoomSubscription { sender, receiver };
            }
        }
        let mut channels = self.channels.write().await;
        if let Some(sender) = channels.get(&key).cloned() {
            let receiver = sender.subscribe();
            return RoomSubscription { sender, receiver };
        }
        let (sender, receiver) = broadcast::channel(512);
        channels.insert(key, sender.clone());
        RoomSubscription { sender, receiver }
    }

    pub async fn subscribe_project(&self, project_id: Uuid) -> RoomSubscription {
        self.subscribe(project_id, PROJECT_CONTROL_ROOM).await
    }

    pub async fn remove_project_sender_if_idle(
        &self,
        project_id: Uuid,
        sender: &broadcast::Sender<RoomEvent>,
    ) {
        self.remove_if_idle(project_id, PROJECT_CONTROL_ROOM, sender)
            .await;
    }

    pub async fn remove_if_idle(
        &self,
        project_id: Uuid,
        doc_id: &str,
        sender: &broadcast::Sender<RoomEvent>,
    ) {
        if sender.receiver_count() != 0 {
            return;
        }
        let key = RoomKey {
            project_id,
            doc_id: doc_id.to_string(),
        };
        let mut channels = self.channels.write().await;
        if channels
            .get(&key)
            .is_some_and(|existing| existing.same_channel(sender) && sender.receiver_count() == 0)
        {
            channels.remove(&key);
        }
    }

    pub async fn invalidate_project(&self, project_id: Uuid, content_epoch: i64) {
        self.broadcast_project(
            project_id,
            RoomEventKind::ProjectReplaced,
            serde_json::json!({"content_epoch": content_epoch}),
        )
        .await;
    }

    pub async fn access_changed(&self, project_id: Uuid) {
        self.broadcast_project(
            project_id,
            RoomEventKind::AccessChanged,
            serde_json::json!({}),
        )
        .await;
    }

    pub async fn workspace_changed(&self, project_id: Uuid, change: &WorkspaceChange) {
        let payload = match change {
            WorkspaceChange::Document {
                path,
                document_id,
                collaboration_revision,
                change_sequence,
            } => RealtimeWorkspaceChangedPayload {
                scope: RealtimeWorkspaceChangeScope::Document,
                path: Some(path.clone()),
                document_id: Some(*document_id),
                collaboration_revision: Some(*collaboration_revision),
                change_sequence: Some(*change_sequence),
            },
            WorkspaceChange::Tree { path } => RealtimeWorkspaceChangedPayload {
                scope: RealtimeWorkspaceChangeScope::Tree,
                path: path.clone(),
                document_id: None,
                collaboration_revision: None,
                change_sequence: None,
            },
            WorkspaceChange::Settings => RealtimeWorkspaceChangedPayload {
                scope: RealtimeWorkspaceChangeScope::Settings,
                path: None,
                document_id: None,
                collaboration_revision: None,
                change_sequence: None,
            },
            WorkspaceChange::Assets { path } => RealtimeWorkspaceChangedPayload {
                scope: RealtimeWorkspaceChangeScope::Assets,
                path: path.clone(),
                document_id: None,
                collaboration_revision: None,
                change_sequence: None,
            },
        };
        let sender = self
            .channels
            .read()
            .await
            .get(&RoomKey {
                project_id,
                doc_id: PROJECT_CONTROL_ROOM.to_string(),
            })
            .cloned();
        if let Some(sender) = sender {
            let _ = sender.send(RoomEvent::system(
                project_id.to_string(),
                RoomEventKind::WorkspaceChanged,
                serde_json::json!(payload),
            ));
        }
    }

    async fn broadcast_project(&self, project_id: Uuid, kind: RoomEventKind, payload: Value) {
        let rooms = self
            .channels
            .read()
            .await
            .iter()
            .filter(|(key, _)| key.project_id == project_id)
            .map(|(key, sender)| (key.doc_id.clone(), sender.clone()))
            .collect::<Vec<_>>();
        for (doc_id, sender) in rooms {
            let _ = sender.send(RoomEvent::system(doc_id, kind, payload.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn project_invalidation_keeps_the_room_document_id(
    ) -> Result<(), broadcast::error::RecvError> {
        let rooms = CollaborationRooms::default();
        let project_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let stream_id = format!("{document_id}:3");
        let RoomSubscription {
            sender: _,
            mut receiver,
        } = rooms.subscribe(project_id, &stream_id).await;

        rooms.invalidate_project(project_id, 7).await;

        let event = receiver.recv().await?;
        assert_eq!(event.doc_id, stream_id);
        assert_eq!(event.kind, RoomEventKind::ProjectReplaced);
        assert_eq!(
            event.payload.get("content_epoch").and_then(Value::as_i64),
            Some(7)
        );
        Ok(())
    }

    #[tokio::test]
    async fn workspace_changes_use_the_project_control_room(
    ) -> Result<(), broadcast::error::RecvError> {
        let rooms = CollaborationRooms::default();
        let project_id = Uuid::new_v4();
        let RoomSubscription {
            sender: _,
            receiver: mut document_receiver,
        } = rooms.subscribe(project_id, "document-id").await;
        let RoomSubscription {
            sender: _,
            receiver: mut control_receiver,
        } = rooms.subscribe_project(project_id).await;

        rooms
            .workspace_changed(
                project_id,
                &WorkspaceChange::Tree {
                    path: Some("images".to_string()),
                },
            )
            .await;

        let event = control_receiver.recv().await?;
        assert_eq!(event.kind, RoomEventKind::WorkspaceChanged);
        assert_eq!(
            event.payload.get("scope").and_then(Value::as_str),
            Some("tree")
        );
        assert_eq!(
            event.payload.get("path").and_then(Value::as_str),
            Some("images")
        );
        assert!(matches!(
            document_receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_last_leave_and_join_keep_the_joined_channel_mapped(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let rooms = CollaborationRooms::default();
        let project_id = Uuid::new_v4();
        let stream_id = "document:0";
        let RoomSubscription {
            sender: previous_sender,
            receiver: previous_receiver,
        } = rooms.subscribe(project_id, stream_id).await;
        drop(previous_receiver);

        let start = Arc::new(tokio::sync::Barrier::new(3));
        let cleanup = {
            let rooms = rooms.clone();
            let start = start.clone();
            let previous_sender = previous_sender.clone();
            tokio::spawn(async move {
                start.wait().await;
                rooms
                    .remove_if_idle(project_id, stream_id, &previous_sender)
                    .await;
            })
        };
        let join = {
            let rooms = rooms.clone();
            let start = start.clone();
            tokio::spawn(async move {
                start.wait().await;
                rooms.subscribe(project_id, stream_id).await
            })
        };

        start.wait().await;
        cleanup.await?;
        let mut subscription = join.await?;
        let mapped_sender = rooms
            .channels
            .read()
            .await
            .get(&RoomKey {
                project_id,
                doc_id: stream_id.to_string(),
            })
            .cloned()
            .ok_or_else(|| std::io::Error::other("joined room was removed"))?;
        assert!(mapped_sender.same_channel(&subscription.sender));

        rooms.invalidate_project(project_id, 9).await;
        let event = subscription.receiver.recv().await?;
        assert_eq!(event.kind, RoomEventKind::ProjectReplaced);
        Ok(())
    }
}
