use super::persistence::{BootstrapState, PersistedUpdateKind};
use super::rooms::{RoomEvent, RoomEventKind, RoomEventOrigin};
use super::updates::{PersistUpdateOutcome, PersistedUpdateAck};
use super::yjs_state::validate_update;
use super::CollaborationDocument;
use crate::access::{
    ensure_project_access, ensure_project_role, project_access_epoch, AccessNeed,
    ProjectAuthorizationError,
};
use crate::app_state::AppState;
use crate::http_response::ApiError;
use crate::protocol::{
    ApiErrorCode, RealtimeClientMessage, RealtimeServerEvent, RealtimeServerEventKind,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose;
use base64::Engine;
use futures::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use std::time::Duration;
use thiserror::Error;
use tracing::warn;
use uuid::Uuid;

const AUTHORIZATION_REVALIDATION_INTERVAL: Duration = Duration::from_secs(30);
const OUTBOUND_CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const SOCKET_EVENT_BUFFER: usize = 8;

#[derive(Debug, Deserialize)]
pub(crate) struct WsQuery {
    pub project_id: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub session_token: Option<String>,
    pub share_token: Option<String>,
    pub guest_session: Option<String>,
    pub collaboration_revision: Option<i64>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct RealtimeAuthResponse {
    pub user_id: Uuid,
}

#[derive(Debug, Clone)]
struct WsAuth {
    project_id: Uuid,
    user_id: Option<Uuid>,
    guest_display_name: Option<String>,
    effective_id: Uuid,
    can_write: bool,
    content_epoch: i64,
    access_epoch: i64,
    target: WsTarget,
    auth_headers: HeaderMap,
}

#[derive(Debug, Clone, Copy)]
enum WsTarget {
    Project,
    Document {
        id: Uuid,
        collaboration_revision: i64,
    },
}

struct IncomingRoomEvent {
    kind: RoomEventKind,
    payload: serde_json::Value,
    persisted_kind: Option<PersistedUpdateKind>,
    request_id: Option<String>,
}

enum PersistEventOutcome {
    Accepted(PersistedUpdateAck),
    InvalidPayload,
    StaleGeneration,
    AccessChanged,
    DocumentChanged,
    Failed,
}

pub(crate) async fn realtime_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RealtimeAuthResponse>, ApiError> {
    let user_id = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(RealtimeAuthResponse { user_id }))
}

pub(crate) async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(doc_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let document_id = match Uuid::parse_str(&doc_id) {
        Ok(document_id) => document_id,
        Err(_) => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Realtime document ID is invalid",
            )
            .into_response()
        }
    };
    let collaboration_revision = match query.collaboration_revision {
        Some(revision) if revision >= 0 => revision,
        _ => {
            return ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BadRequest,
                "Realtime collaboration revision is required",
            )
            .into_response()
        }
    };
    let auth = match authorize_ws_user(
        &state,
        &headers,
        &query,
        document_id,
        collaboration_revision,
    )
    .await
    {
        Ok(auth) => auth,
        Err(failure) => return authorization_error_response(failure),
    };
    let user_name = query.user_name.clone();
    let room_id = format!("{document_id}:{collaboration_revision}");
    ws.on_upgrade(move |socket| handle_socket(socket, room_id, auth, user_name, state))
        .into_response()
}

pub(crate) async fn project_ws_handler(
    ws: WebSocketUpgrade,
    Path(project_id): Path<Uuid>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let auth = match authorize_project_ws_user(&state, &headers, &query, project_id).await {
        Ok(auth) => auth,
        Err(failure) => return authorization_error_response(failure),
    };
    ws.on_upgrade(move |socket| handle_project_socket(socket, auth, state))
        .into_response()
}

fn authorization_error_response(failure: AuthorizeWebSocketError) -> axum::response::Response {
    match failure {
        AuthorizeWebSocketError::MissingProjectId
        | AuthorizeWebSocketError::InvalidProjectId { .. }
        | AuthorizeWebSocketError::InvalidCredentialHeader { .. }
        | AuthorizeWebSocketError::ProjectNotFound { .. }
        | AuthorizeWebSocketError::DocumentNotFound { .. }
        | AuthorizeWebSocketError::Authorization(
            ProjectAuthorizationError::AuthenticationRequired
            | ProjectAuthorizationError::PermissionDenied,
        ) => ApiError::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::Unauthorized,
            "Realtime authentication failed",
        )
        .into_response(),
        failure => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::AuthorizationUnavailable,
            "Realtime authorization is unavailable",
        )
        .with_diagnostic("realtime authorization failed", failure)
        .into_response(),
    }
}

async fn authorize_ws_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &WsQuery,
    document_id: Uuid,
    collaboration_revision: i64,
) -> Result<WsAuth, AuthorizeWebSocketError> {
    let project_id = query
        .project_id
        .as_ref()
        .ok_or(AuthorizeWebSocketError::MissingProjectId)?;
    let project_id = Uuid::parse_str(project_id)
        .map_err(|source| AuthorizeWebSocketError::InvalidProjectId { source })?;
    let auth = authorize_project_ws_user(state, headers, query, project_id).await?;
    let document_exists = crate::workspace::document_collaboration_revision_matches(
        &state.db,
        project_id,
        document_id,
        collaboration_revision,
    )
    .await
    .map_err(|source| AuthorizeWebSocketError::DocumentQuery {
        project_id,
        document_id,
        source,
    })?;
    if !document_exists {
        return Err(AuthorizeWebSocketError::DocumentNotFound {
            project_id,
            document_id,
        });
    }
    Ok(WsAuth {
        target: WsTarget::Document {
            id: document_id,
            collaboration_revision,
        },
        ..auth
    })
}

async fn authorize_project_ws_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &WsQuery,
    project_id: Uuid,
) -> Result<WsAuth, AuthorizeWebSocketError> {
    let mut auth_headers = headers.clone();
    if let Some(user_id) = &query.user_id {
        let value = HeaderValue::from_str(user_id.trim()).map_err(|source| {
            AuthorizeWebSocketError::InvalidCredentialHeader {
                name: "user_id",
                source,
            }
        })?;
        auth_headers.insert("x-user-id", value);
    }
    if let Some(session_token) = &query.session_token {
        let value = HeaderValue::from_str(&format!("typst_session={}", session_token.trim()))
            .map_err(|source| AuthorizeWebSocketError::InvalidCredentialHeader {
                name: "session_token",
                source,
            })?;
        auth_headers.insert("cookie", value);
    }
    if let Some(share_token) = &query.share_token {
        let value = HeaderValue::from_str(share_token.trim()).map_err(|source| {
            AuthorizeWebSocketError::InvalidCredentialHeader {
                name: "share_token",
                source,
            }
        })?;
        auth_headers.insert("x-share-token", value);
    }
    if let Some(guest_session) = &query.guest_session {
        let value = HeaderValue::from_str(guest_session.trim()).map_err(|source| {
            AuthorizeWebSocketError::InvalidCredentialHeader {
                name: "guest_session",
                source,
            }
        })?;
        auth_headers.insert("x-guest-session", value);
    }
    let principal = ensure_project_access(&state.db, &auth_headers, project_id, AccessNeed::Read)
        .await
        .map_err(AuthorizeWebSocketError::Authorization)?;
    let effective_id = principal
        .user_id
        .or(principal.guest_session_id)
        .unwrap_or_else(Uuid::new_v4);
    let content_epoch = crate::workspace::project_content_epoch(&state.db, project_id)
        .await
        .map_err(|source| AuthorizeWebSocketError::ContentEpoch { project_id, source })?
        .ok_or(AuthorizeWebSocketError::ProjectNotFound { project_id })?;
    let access_epoch = project_access_epoch(&state.db, project_id)
        .await
        .map_err(|source| AuthorizeWebSocketError::AccessEpoch { project_id, source })?
        .ok_or(AuthorizeWebSocketError::ProjectNotFound { project_id })?;
    Ok(WsAuth {
        project_id,
        user_id: principal.user_id,
        guest_display_name: principal.guest_display_name,
        effective_id,
        can_write: principal.can_write,
        content_epoch,
        access_epoch,
        target: WsTarget::Project,
        auth_headers,
    })
}

#[derive(Debug, Error)]
enum AuthorizeWebSocketError {
    #[error("realtime request is missing project_id")]
    MissingProjectId,
    #[error("realtime request has an invalid project_id")]
    InvalidProjectId {
        #[source]
        source: uuid::Error,
    },
    #[error("realtime request has an invalid {name} credential")]
    InvalidCredentialHeader {
        name: &'static str,
        #[source]
        source: axum::http::header::InvalidHeaderValue,
    },
    #[error(transparent)]
    Authorization(#[from] ProjectAuthorizationError),
    #[error("could not read content epoch for realtime project {project_id}")]
    ContentEpoch {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not read access epoch for realtime project {project_id}")]
    AccessEpoch {
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
    #[error("realtime project {project_id} was not found")]
    ProjectNotFound { project_id: Uuid },
    #[error("realtime document {document_id} was not found in project {project_id}")]
    DocumentNotFound { project_id: Uuid, document_id: Uuid },
    #[error("could not validate realtime document {document_id} in project {project_id}")]
    DocumentQuery {
        project_id: Uuid,
        document_id: Uuid,
        #[source]
        source: crate::workspace::DocumentIdentityQueryError,
    },
}

fn client_message_event(message: RealtimeClientMessage, can_write: bool) -> IncomingRoomEvent {
    match message {
        RealtimeClientMessage::YjsUpdate {
            payload,
            request_id,
            ..
        } => IncomingRoomEvent {
            kind: RoomEventKind::YjsUpdate,
            payload: serde_json::Value::String(payload),
            persisted_kind: Some(PersistedUpdateKind::Update),
            request_id: Some(request_id),
        },
        RealtimeClientMessage::YjsSync {
            payload,
            request_id,
            ..
        } => IncomingRoomEvent {
            kind: RoomEventKind::YjsSync,
            payload: serde_json::Value::String(payload),
            persisted_kind: Some(PersistedUpdateKind::Sync),
            request_id: Some(request_id),
        },
        RealtimeClientMessage::PresenceMetadata { payload, .. } => IncomingRoomEvent {
            kind: RoomEventKind::PresenceMetadata,
            payload: serde_json::json!({
                "user_name": payload.user_name,
                "can_write": can_write,
            }),
            persisted_kind: None,
            request_id: None,
        },
        RealtimeClientMessage::PresenceCursor { payload, .. } => IncomingRoomEvent {
            kind: RoomEventKind::PresenceCursor,
            payload: serde_json::json!({
                "line": payload.line,
                "column": payload.column,
                "user_name": payload.user_name,
                "can_write": can_write,
            }),
            persisted_kind: None,
            request_id: None,
        },
    }
}

fn room_event_to_protocol(
    event: RoomEvent,
    recipient_connection_id: Option<Uuid>,
) -> RealtimeServerEvent {
    let (user_id, connection_id) = match event.origin {
        RoomEventOrigin::System => ("system".to_string(), None),
        RoomEventOrigin::Connection {
            member_id,
            connection_id,
        } => (member_id, Some(connection_id)),
    };
    let is_current_connection = connection_id.is_some() && connection_id == recipient_connection_id;
    RealtimeServerEvent {
        doc_id: event.doc_id,
        user_id,
        connection_id,
        is_current_connection,
        kind: match event.kind {
            RoomEventKind::YjsUpdate => RealtimeServerEventKind::YjsUpdate,
            RoomEventKind::YjsSync => RealtimeServerEventKind::YjsSync,
            RoomEventKind::YjsAck => RealtimeServerEventKind::YjsAck,
            RoomEventKind::PresenceJoin => RealtimeServerEventKind::PresenceJoin,
            RoomEventKind::PresenceLeave => RealtimeServerEventKind::PresenceLeave,
            RoomEventKind::PresenceMetadata => RealtimeServerEventKind::PresenceMetadata,
            RoomEventKind::PresenceCursor => RealtimeServerEventKind::PresenceCursor,
            RoomEventKind::BootstrapDone => RealtimeServerEventKind::BootstrapDone,
            RoomEventKind::WorkspaceChanged => RealtimeServerEventKind::WorkspaceChanged,
            RoomEventKind::DocumentChanged => RealtimeServerEventKind::DocumentChanged,
            RoomEventKind::ProjectReplaced => RealtimeServerEventKind::ProjectReplaced,
            RoomEventKind::AccessChanged => RealtimeServerEventKind::AccessChanged,
            RoomEventKind::ServerError => RealtimeServerEventKind::ServerError,
        },
        payload: event.payload,
        at: event.at,
    }
}

fn yjs_payload_to_bytes(payload: &serde_json::Value) -> Option<Vec<u8>> {
    payload
        .as_str()
        .and_then(|text| general_purpose::STANDARD.decode(text).ok())
}

fn bytes_to_json_payload(bytes: &[u8]) -> serde_json::Value {
    serde_json::Value::String(general_purpose::STANDARD.encode(bytes))
}

async fn send_room_event(
    ws_tx: &mut futures::stream::SplitSink<WebSocket, Message>,
    event: RoomEvent,
    recipient_connection_id: Option<Uuid>,
) -> Result<(), SendRoomEventError> {
    let text = serde_json::to_string(&room_event_to_protocol(event, recipient_connection_id))
        .map_err(SendRoomEventError::Serialize)?;
    ws_tx
        .send(Message::Text(text.into()))
        .await
        .map_err(SendRoomEventError::Send)
}

#[derive(Debug, Error)]
enum SendRoomEventError {
    #[error("could not serialize realtime event")]
    Serialize(#[source] serde_json::Error),
    #[error("could not send realtime event")]
    Send(#[source] axum::Error),
}

async fn send_bootstrap_state(
    ws_tx: &mut futures::stream::SplitSink<WebSocket, Message>,
    doc_id: &str,
    state: BootstrapState,
    connection_id: Uuid,
) -> Result<(), SendRoomEventError> {
    if let Some(snapshot) = state.snapshot_payload {
        let event = RoomEvent::system(
            doc_id,
            RoomEventKind::YjsSync,
            bytes_to_json_payload(&snapshot),
        );
        send_room_event(ws_tx, event, Some(connection_id)).await?;
    }
    for (kind, payload) in state.updates {
        let kind = match kind {
            PersistedUpdateKind::Update => RoomEventKind::YjsUpdate,
            PersistedUpdateKind::Sync => RoomEventKind::YjsSync,
        };
        let event = RoomEvent::system(doc_id, kind, bytes_to_json_payload(&payload));
        send_room_event(ws_tx, event, Some(connection_id)).await?;
    }
    let done = RoomEvent::system(doc_id, RoomEventKind::BootstrapDone, serde_json::json!({}));
    send_room_event(ws_tx, done, Some(connection_id)).await
}

async fn send_server_error_and_close(
    ws_tx: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream_id: &str,
    message: &str,
) {
    let _ = send_room_event(
        ws_tx,
        RoomEvent::system(
            stream_id,
            RoomEventKind::ServerError,
            serde_json::json!({
                "message": message,
                "resync_required": true
            }),
        ),
        None,
    )
    .await;
    let _ = ws_tx.send(Message::Close(None)).await;
}

async fn forward_room_events(
    mut receiver: tokio::sync::broadcast::Receiver<RoomEvent>,
    mut socket_receiver: tokio::sync::mpsc::Receiver<RoomEvent>,
    mut ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    stream_id: String,
    connection_id: Option<Uuid>,
) {
    loop {
        let event = tokio::select! {
            room_event = receiver.recv() => {
                match room_event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, %stream_id, "realtime client lagged behind room events");
                        send_server_error_and_close(
                            &mut ws_tx,
                            &stream_id,
                            "Realtime stream fell behind; reconnect to resynchronize",
                        )
                        .await;
                        break;
                    }
                }
            }
            Some(event) = socket_receiver.recv() => event,
        };
        let closes_stream = matches!(
            event.kind,
            RoomEventKind::AccessChanged
                | RoomEventKind::DocumentChanged
                | RoomEventKind::ProjectReplaced
        ) || (event.kind == RoomEventKind::ServerError
            && event
                .payload
                .get("resync_required")
                .and_then(serde_json::Value::as_bool)
                == Some(true));
        if send_room_event(&mut ws_tx, event, connection_id)
            .await
            .is_err()
        {
            break;
        }
        if closes_stream {
            let _ = ws_tx.send(Message::Close(None)).await;
            break;
        }
    }
}

async fn finish_event_forwarder(
    mut task: tokio::task::JoinHandle<()>,
    drain_close_event: bool,
    stream_id: &str,
) {
    let join_result = if drain_close_event {
        match tokio::time::timeout(OUTBOUND_CLOSE_DRAIN_TIMEOUT, &mut task).await {
            Ok(result) => result,
            Err(_) => {
                warn!(%stream_id, "timed out draining realtime close event");
                task.abort();
                task.await
            }
        }
    } else {
        task.abort();
        task.await
    };
    if let Err(join_error) = join_result {
        if !join_error.is_cancelled() {
            warn!(%join_error, %stream_id, "realtime sender task failed");
        }
    }
}

async fn persist_yjs_event(
    state: &AppState,
    auth: &WsAuth,
    kind: PersistedUpdateKind,
    payload: &serde_json::Value,
) -> PersistEventOutcome {
    let Some(payload_bytes) = yjs_payload_to_bytes(payload) else {
        return PersistEventOutcome::InvalidPayload;
    };
    match ensure_project_access(
        &state.db,
        &auth.auth_headers,
        auth.project_id,
        AccessNeed::Write,
    )
    .await
    {
        Ok(_) => {}
        Err(
            ProjectAuthorizationError::AuthenticationRequired
            | ProjectAuthorizationError::PermissionDenied,
        ) => return PersistEventOutcome::AccessChanged,
        Err(error) => {
            warn!(%error, "failed to revalidate collaboration write access");
            return PersistEventOutcome::Failed;
        }
    }
    if let Err(error) = validate_update(&payload_bytes) {
        warn!(%error, "ignored invalid Yjs update");
        return PersistEventOutcome::InvalidPayload;
    }
    let WsTarget::Document {
        id: document_id,
        collaboration_revision,
    } = auth.target
    else {
        return PersistEventOutcome::Failed;
    };
    let document = CollaborationDocument {
        project_id: auth.project_id,
        document_id,
        collaboration_revision,
        content_epoch: auth.content_epoch,
    };
    match state
        .collaboration
        .persist_update(
            document,
            auth.user_id,
            kind,
            &payload_bytes,
            auth.access_epoch,
            auth.guest_display_name.as_deref(),
        )
        .await
    {
        Ok(PersistUpdateOutcome::Accepted(ack)) => PersistEventOutcome::Accepted(ack),
        Ok(PersistUpdateOutcome::ContentEpochChanged) => PersistEventOutcome::StaleGeneration,
        Ok(PersistUpdateOutcome::AccessChanged) => PersistEventOutcome::AccessChanged,
        Ok(PersistUpdateOutcome::DocumentChanged) => PersistEventOutcome::DocumentChanged,
        Err(error) => {
            warn!(%error, "failed to persist collaboration update");
            PersistEventOutcome::Failed
        }
    }
}

enum RevalidationOutcome {
    Current,
    AccessChanged,
    ProjectReplaced,
    Unavailable,
}

async fn revalidate_project(state: &AppState, auth: &WsAuth) -> RevalidationOutcome {
    match ensure_project_access(
        &state.db,
        &auth.auth_headers,
        auth.project_id,
        AccessNeed::Read,
    )
    .await
    {
        Ok(_) => {}
        Err(
            error @ (ProjectAuthorizationError::AuthenticationRequired
            | ProjectAuthorizationError::PermissionDenied),
        ) => {
            warn!(%error, project_id = %auth.project_id, "realtime access revalidation failed");
            return RevalidationOutcome::AccessChanged;
        }
        Err(error) => {
            warn!(%error, project_id = %auth.project_id, "realtime access revalidation is unavailable");
            return RevalidationOutcome::Unavailable;
        }
    }
    match crate::workspace::project_content_epoch(&state.db, auth.project_id).await {
        Ok(Some(content_epoch)) if content_epoch != auth.content_epoch => {
            return RevalidationOutcome::ProjectReplaced
        }
        Ok(Some(_)) => {}
        Ok(None) => return RevalidationOutcome::ProjectReplaced,
        Err(error) => {
            warn!(%error, project_id = %auth.project_id, "realtime content epoch revalidation failed");
            return RevalidationOutcome::Unavailable;
        }
    }
    match project_access_epoch(&state.db, auth.project_id).await {
        Ok(Some(access_epoch)) if access_epoch != auth.access_epoch => {
            RevalidationOutcome::AccessChanged
        }
        Ok(Some(_)) => RevalidationOutcome::Current,
        Ok(None) => RevalidationOutcome::AccessChanged,
        Err(error) => {
            warn!(%error, project_id = %auth.project_id, "realtime access epoch revalidation failed");
            RevalidationOutcome::Unavailable
        }
    }
}

fn revalidation_event(stream_id: &str, outcome: RevalidationOutcome) -> Option<RoomEvent> {
    let (kind, payload) = match outcome {
        RevalidationOutcome::Current => return None,
        RevalidationOutcome::AccessChanged => (RoomEventKind::AccessChanged, serde_json::json!({})),
        RevalidationOutcome::ProjectReplaced => {
            (RoomEventKind::ProjectReplaced, serde_json::json!({}))
        }
        RevalidationOutcome::Unavailable => (
            RoomEventKind::ServerError,
            serde_json::json!({
                "message": "Realtime authorization could not be revalidated",
                "resync_required": true
            }),
        ),
    };
    Some(RoomEvent::system(stream_id, kind, payload))
}

async fn handle_socket(
    socket: WebSocket,
    doc_id: String,
    auth: WsAuth,
    user_name: Option<String>,
    state: AppState,
) {
    let WsTarget::Document {
        id: document_id,
        collaboration_revision,
    } = auth.target
    else {
        return;
    };
    let document = CollaborationDocument {
        project_id: auth.project_id,
        document_id,
        collaboration_revision,
        content_epoch: auth.content_epoch,
    };
    let sender = state
        .collaboration
        .rooms
        .sender(auth.project_id, &doc_id)
        .await;
    let receiver = sender.subscribe();
    let (socket_sender, socket_receiver) = tokio::sync::mpsc::channel(SOCKET_EVENT_BUFFER);
    let (mut ws_tx, mut ws_rx) = socket.split();
    let user_id = auth.effective_id.to_string();
    let connection_id = Uuid::new_v4();

    let bootstrap = match state
        .collaboration
        .prepare_document_bootstrap(document)
        .await
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            warn!(%error, %doc_id, "failed to load collaboration bootstrap");
            send_server_error_and_close(
                &mut ws_tx,
                &doc_id,
                "Failed to load collaborative document state",
            )
            .await;
            drop(receiver);
            state
                .collaboration
                .rooms
                .remove_if_idle(auth.project_id, &doc_id, &sender)
                .await;
            return;
        }
    };
    if send_bootstrap_state(&mut ws_tx, &doc_id, bootstrap, connection_id)
        .await
        .is_err()
    {
        drop(receiver);
        state
            .collaboration
            .rooms
            .remove_if_idle(auth.project_id, &doc_id, &sender)
            .await;
        return;
    }

    let joined = RoomEvent::from_connection(
        &doc_id,
        &user_id,
        connection_id,
        RoomEventKind::PresenceJoin,
        serde_json::json!({
            "user_id": user_id,
            "user_name": user_name,
            "auth_kind": "project-scoped",
            "can_write": auth.can_write
        }),
    );
    let _ = sender.send(joined);

    let send_task = tokio::spawn(forward_room_events(
        receiver,
        socket_receiver,
        ws_tx,
        doc_id.clone(),
        Some(connection_id),
    ));
    let mut drain_close_event = false;

    let start = tokio::time::Instant::now() + AUTHORIZATION_REVALIDATION_INTERVAL;
    let mut authorization_interval =
        tokio::time::interval_at(start, AUTHORIZATION_REVALIDATION_INTERVAL);
    loop {
        let message = tokio::select! {
            message = ws_rx.next() => message,
            _ = authorization_interval.tick() => {
                let Some(event) = revalidation_event(
                    &doc_id,
                    revalidate_project(&state, &auth).await,
                ) else {
                    continue;
                };
                drain_close_event = socket_sender
                    .send(event)
                    .await
                    .is_ok();
                break;
            }
        };
        let Some(Ok(message)) = message else {
            break;
        };
        match message {
            Message::Text(text) => {
                let incoming = match serde_json::from_str::<RealtimeClientMessage>(&text) {
                    Ok(message) => message,
                    Err(error) => {
                        warn!(%error, "ignored invalid collaboration client message");
                        continue;
                    }
                };
                let incoming = client_message_event(incoming, auth.can_write);
                if incoming.kind == RoomEventKind::PresenceCursor && !auth.can_write {
                    continue;
                }
                if let Some(persisted_kind) = incoming.persisted_kind {
                    if !auth.can_write {
                        continue;
                    }
                    let Some(request_id) = incoming.request_id.as_deref() else {
                        continue;
                    };
                    match persist_yjs_event(&state, &auth, persisted_kind, &incoming.payload).await
                    {
                        PersistEventOutcome::Accepted(ack) => {
                            let acknowledgement = RoomEvent::system(
                                &doc_id,
                                RoomEventKind::YjsAck,
                                serde_json::json!({
                                    "request_id": request_id,
                                    "update_id": ack.update_id,
                                    "projected": ack.projected,
                                }),
                            );
                            if socket_sender.send(acknowledgement).await.is_err() {
                                break;
                            }
                            if let Some(change) = ack.workspace_change {
                                state
                                    .collaboration
                                    .workspace_changed(auth.project_id, change)
                                    .await;
                            }
                        }
                        PersistEventOutcome::InvalidPayload => continue,
                        PersistEventOutcome::StaleGeneration => {
                            drain_close_event = socket_sender
                                .send(RoomEvent::system(
                                    &doc_id,
                                    RoomEventKind::ProjectReplaced,
                                    serde_json::json!({}),
                                ))
                                .await
                                .is_ok();
                            break;
                        }
                        PersistEventOutcome::AccessChanged => {
                            drain_close_event = socket_sender
                                .send(RoomEvent::system(
                                    &doc_id,
                                    RoomEventKind::AccessChanged,
                                    serde_json::json!({}),
                                ))
                                .await
                                .is_ok();
                            break;
                        }
                        PersistEventOutcome::DocumentChanged => {
                            drain_close_event = socket_sender
                                .send(RoomEvent::system(
                                    &doc_id,
                                    RoomEventKind::DocumentChanged,
                                    serde_json::json!({}),
                                ))
                                .await
                                .is_ok();
                            break;
                        }
                        PersistEventOutcome::Failed => {
                            drain_close_event = socket_sender
                                .send(RoomEvent::system(
                                    &doc_id,
                                    RoomEventKind::ServerError,
                                    serde_json::json!({
                                        "message": "Failed to persist collaborative update",
                                        "resync_required": true
                                    }),
                                ))
                                .await
                                .is_ok();
                            break;
                        }
                    }
                }
                let event = RoomEvent::from_connection(
                    &doc_id,
                    &user_id,
                    connection_id,
                    incoming.kind,
                    incoming.payload,
                );
                let _ = sender.send(event);
            }
            Message::Binary(_) => {
                warn!("ignored unsupported binary collaboration client message");
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let left = RoomEvent::from_connection(
        &doc_id,
        &user_id,
        connection_id,
        RoomEventKind::PresenceLeave,
        serde_json::json!({}),
    );
    let _ = sender.send(left);
    finish_event_forwarder(send_task, drain_close_event, &doc_id).await;
    state
        .collaboration
        .rooms
        .remove_if_idle(auth.project_id, &doc_id, &sender)
        .await;
}

async fn handle_project_socket(socket: WebSocket, auth: WsAuth, state: AppState) {
    let stream_id = auth.project_id.to_string();
    let sender = state
        .collaboration
        .rooms
        .project_sender(auth.project_id)
        .await;
    let receiver = sender.subscribe();
    let (socket_sender, socket_receiver) = tokio::sync::mpsc::channel(SOCKET_EVENT_BUFFER);
    let (mut ws_tx, mut ws_rx) = socket.split();
    let ready = RoomEvent::system(
        &stream_id,
        RoomEventKind::BootstrapDone,
        serde_json::json!({}),
    );
    if send_room_event(&mut ws_tx, ready, None).await.is_err() {
        drop(receiver);
        state
            .collaboration
            .rooms
            .remove_project_sender_if_idle(auth.project_id, &sender)
            .await;
        return;
    }
    let send_task = tokio::spawn(forward_room_events(
        receiver,
        socket_receiver,
        ws_tx,
        stream_id.clone(),
        None,
    ));
    let mut drain_close_event = false;
    let start = tokio::time::Instant::now() + AUTHORIZATION_REVALIDATION_INTERVAL;
    let mut authorization_interval =
        tokio::time::interval_at(start, AUTHORIZATION_REVALIDATION_INTERVAL);
    loop {
        let message = tokio::select! {
            message = ws_rx.next() => message,
            _ = authorization_interval.tick() => {
                let Some(event) = revalidation_event(
                    &stream_id,
                    revalidate_project(&state, &auth).await,
                ) else {
                    continue;
                };
                drain_close_event = socket_sender
                    .send(event)
                    .await
                    .is_ok();
                break;
            }
        };
        let Some(Ok(message)) = message else {
            break;
        };
        if matches!(message, Message::Close(_)) {
            break;
        }
    }
    finish_event_forwarder(send_task, drain_close_event, &auth.project_id.to_string()).await;
    state
        .collaboration
        .rooms
        .remove_project_sender_if_idle(auth.project_id, &sender)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_events_identify_only_the_receiving_connection() {
        let current_connection_id = Uuid::new_v4();
        let other_connection_id = Uuid::new_v4();
        let current = room_event_to_protocol(
            RoomEvent::from_connection(
                "document",
                "member",
                current_connection_id,
                RoomEventKind::PresenceCursor,
                serde_json::json!({}),
            ),
            Some(current_connection_id),
        );
        let other = room_event_to_protocol(
            RoomEvent::from_connection(
                "document",
                "member",
                other_connection_id,
                RoomEventKind::PresenceCursor,
                serde_json::json!({}),
            ),
            Some(current_connection_id),
        );

        assert!(current.is_current_connection);
        assert!(!other.is_current_connection);
    }

    #[test]
    fn rejects_unknown_client_message_kind() {
        let parsed = serde_json::from_str::<RealtimeClientMessage>(
            r#"{"kind":"arbitrary.event","origin":"test","payload":{}}"#,
        );
        assert!(parsed.is_err());
    }

    #[test]
    fn presence_write_capability_comes_from_authorization() -> Result<(), serde_json::Error> {
        let message = serde_json::from_str::<RealtimeClientMessage>(
            r#"{"kind":"presence.meta","origin":"test","payload":{"user_name":"Guest","can_write":true}}"#,
        )?;
        let event = client_message_event(message, false);
        assert_eq!(
            event
                .payload
                .get("can_write")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        Ok(())
    }

    #[test]
    fn workspace_change_room_events_keep_their_wire_kind_and_payload() {
        let event = room_event_to_protocol(
            RoomEvent::system(
                "project:main.typ",
                RoomEventKind::WorkspaceChanged,
                serde_json::json!({"scope": "settings", "path": null}),
            ),
            None,
        );

        assert_eq!(event.kind, RealtimeServerEventKind::WorkspaceChanged);
        assert_eq!(
            event
                .payload
                .get("scope")
                .and_then(serde_json::Value::as_str),
            Some("settings")
        );
    }

    #[test]
    fn unavailable_revalidation_requests_resync_without_claiming_access_changed(
    ) -> Result<(), &'static str> {
        let event = revalidation_event("document-a:0", RevalidationOutcome::Unavailable)
            .ok_or("unavailable revalidation did not create a close event")?;

        assert_eq!(event.kind, RoomEventKind::ServerError);
        assert_eq!(
            event
                .payload
                .get("resync_required")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        Ok(())
    }
}
