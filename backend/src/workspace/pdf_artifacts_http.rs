//! HTTP transport for browser-produced PDF artifacts.

use super::file_policy::sanitize_project_path;
use super::http_error::project_service_unavailable;
use super::pdf_artifacts::{
    load_latest_pdf_artifact, upload_pdf_artifact, LoadLatestPdfArtifactError, UploadPdfArtifact,
    UploadPdfArtifactError,
};
use super::{load_project_entry_point, LoadProjectEntryPointError, PdfArtifact};
use crate::access::{ensure_project_role, AccessNeed};
use crate::app_state::AppState;
use crate::audit::record_event;
use crate::http_response::ApiError;
use crate::protocol::ApiErrorCode;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::Path as FilePath;
use uuid::Uuid;

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(crate) struct UploadPdfArtifactInput {
    pub entry_file_path: Option<String>,
    pub content_base64: String,
    pub content_type: Option<String>,
}

pub(crate) async fn upload_project_pdf_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadPdfArtifactInput>,
) -> Result<Json<PdfArtifact>, ApiError> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let project_entry_point = load_project_entry_point(&state.db, project_id).await?;
    let entry_file_path = sanitize_project_path(
        input
            .entry_file_path
            .as_deref()
            .unwrap_or(&project_entry_point.entry_file_path),
    )?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.content_base64)
        .map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::PdfArtifactInvalid,
                "PDF artifact input is invalid",
            )
        })?;
    let artifact = upload_pdf_artifact(
        &state.db,
        UploadPdfArtifact {
            project_id,
            entry_file_path: entry_file_path.clone(),
            content_type: input
                .content_type
                .unwrap_or_else(|| "application/pdf".to_string()),
            bytes,
            actor_user_id: actor,
        },
    )
    .await?;
    record_event(
        &state.db,
        Some(actor),
        "project.pdf.upload",
        serde_json::json!({
            "project_id": project_id,
            "pdf_id": artifact.id,
            "entry_file_path": entry_file_path
        }),
    )
    .await;
    Ok(Json(artifact))
}

pub(crate) async fn download_latest_project_pdf_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let artifact = load_latest_pdf_artifact(&state.db, project_id).await?;
    let mut response = axum::http::Response::new(Body::from(artifact.pdf_bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&artifact.content_type)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/pdf")),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        pdf_content_disposition(&artifact.entry_file_path),
    );
    Ok(response)
}

struct PdfDownloadNames {
    ascii_fallback: String,
    utf8: String,
}

fn pdf_download_names(entry_file_path: &str) -> PdfDownloadNames {
    let stem = FilePath::new(entry_file_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let unicode_stem = stem
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let unicode_stem = unicode_stem.trim_matches('.');
    let unicode_stem = if unicode_stem.is_empty() {
        "document"
    } else {
        unicode_stem
    };
    let sanitized_ascii = unicode_stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let sanitized_ascii = sanitized_ascii.trim_matches(['.', '_']);
    let ascii_stem = if sanitized_ascii
        .chars()
        .any(|character| character.is_ascii_alphanumeric())
    {
        sanitized_ascii
    } else {
        "document"
    };
    let ascii_stem = if unicode_stem.is_ascii() {
        ascii_stem.to_string()
    } else {
        let digest = Sha256::digest(unicode_stem.as_bytes());
        let suffix = digest
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("{ascii_stem}-{suffix}")
    };
    PdfDownloadNames {
        ascii_fallback: format!("{ascii_stem}.pdf"),
        utf8: format!("{unicode_stem}.pdf"),
    }
}

fn pdf_content_disposition(entry_file_path: &str) -> header::HeaderValue {
    let names = pdf_download_names(entry_file_path);
    let encoded_utf8 = rfc5987_encode(&names.utf8);
    header::HeaderValue::from_str(&format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{encoded_utf8}",
        names.ascii_fallback
    ))
    .unwrap_or_else(|_| header::HeaderValue::from_static("attachment; filename=\"document.pdf\""))
}

fn rfc5987_encode(value: &str) -> String {
    fn hex_digit(nibble: u8) -> char {
        char::from(if nibble < 10 {
            b'0' + nibble
        } else {
            b'A' + nibble - 10
        })
    }

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
    }
    encoded
}

impl From<LoadProjectEntryPointError> for ApiError {
    fn from(source: LoadProjectEntryPointError) -> Self {
        match source {
            LoadProjectEntryPointError::ProjectNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ProjectNotFound,
                "Project was not found",
            ),
            failure @ LoadProjectEntryPointError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

impl From<UploadPdfArtifactError> for ApiError {
    fn from(source: UploadPdfArtifactError) -> Self {
        match source {
            UploadPdfArtifactError::PayloadTooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::PdfArtifactTooLarge,
                "PDF artifact is too large",
            ),
            failure @ UploadPdfArtifactError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

impl From<LoadLatestPdfArtifactError> for ApiError {
    fn from(source: LoadLatestPdfArtifactError) -> Self {
        match source {
            LoadLatestPdfArtifactError::ArtifactNotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::PdfArtifactNotFound,
                "PDF artifact was not found",
            ),
            failure @ LoadLatestPdfArtifactError::Persistence { .. } => {
                project_service_unavailable(failure)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_pdf_artifacts_have_a_semantic_payload_response() {
        let error = ApiError::from(UploadPdfArtifactError::PayloadTooLarge);

        assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.code(), ApiErrorCode::PdfArtifactTooLarge);
    }

    #[test]
    fn missing_pdf_artifacts_have_a_semantic_not_found_response() {
        let error = ApiError::from(LoadLatestPdfArtifactError::ArtifactNotFound);

        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.code(), ApiErrorCode::PdfArtifactNotFound);
    }

    #[test]
    fn pdf_download_names_cannot_inject_response_headers() {
        assert_eq!(
            pdf_download_names("slides/bad\"\r\nname.typ").ascii_fallback,
            "bad___name.pdf"
        );
        assert_eq!(
            pdf_download_names("slides/...typ").ascii_fallback,
            "document.pdf"
        );
        let value = pdf_content_disposition("slides/bad\"\r\nname.typ");
        assert!(value.to_str().is_ok());
    }

    #[test]
    fn pdf_download_names_preserve_unicode_without_ascii_collisions() {
        let report = pdf_download_names("slides/报告.typ");
        let summary = pdf_download_names("slides/总结.typ");

        assert_eq!(report.utf8, "报告.pdf");
        assert!(report.ascii_fallback.starts_with("document-"));
        assert_ne!(report.ascii_fallback, summary.ascii_fallback);
        let value = pdf_content_disposition("slides/报告.typ");
        assert!(value
            .to_str()
            .is_ok_and(|content| content.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf")));
        assert_eq!(rfc5987_encode("a b.pdf"), "a%20b.pdf");
    }
}
