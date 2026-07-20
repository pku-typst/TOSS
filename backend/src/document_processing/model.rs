//! Domain values and public read contracts owned by Document Processing.

use crate::text_enum::text_enum;
use chrono::{DateTime, Utc};
use uuid::Uuid;

pub(super) fn processing_retry_delay(attempt_count: i32) -> chrono::Duration {
    let shift = u32::try_from(attempt_count.saturating_sub(1))
        .unwrap_or(0)
        .min(5);
    let seconds = 1_i64.checked_shl(shift).unwrap_or(30).min(30);
    chrono::Duration::seconds(seconds)
}

text_enum! {
    #[derive(Hash)]
    pub enum ProcessingOperation {
        LatexCompilePdfV1 => "latex.compile.pdf/v1",
        TypstExportPptxV1 => "typst.export.pptx/v1",
        PptxImportTypstV1 => "pptx.import.typst/v1",
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct CreatePptxImportInput {
    pub filename: String,
    #[serde(default)]
    pub input_profile: Option<String>,
}

impl ProcessingOperation {
    pub(crate) const fn project_type(self) -> Option<crate::workspace::ProjectType> {
        match self {
            Self::LatexCompilePdfV1 => Some(crate::workspace::ProjectType::Latex),
            Self::TypstExportPptxV1 => Some(crate::workspace::ProjectType::Typst),
            Self::PptxImportTypstV1 => None,
        }
    }

    pub(crate) const fn result_project_type(self) -> Option<crate::workspace::ProjectType> {
        match self {
            Self::PptxImportTypstV1 => Some(crate::workspace::ProjectType::Typst),
            Self::LatexCompilePdfV1 | Self::TypstExportPptxV1 => None,
        }
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProcessingJobState {
        Preparing => "preparing",
        Queued => "queued",
        Running => "running",
        Finalizing => "finalizing",
        Succeeded => "succeeded",
        Failed => "failed",
        Cancelled => "cancelled",
        Expired => "expired",
    }
}

impl ProcessingJobState {
    pub(crate) const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Expired
        )
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProcessingPhase {
        CapturingInput => "capturing_input",
        WaitingForWorker => "waiting_for_worker",
        Processing => "processing",
        UploadingResult => "uploading_result",
        ValidatingResult => "validating_result",
        PublishingResult => "publishing_result",
        Complete => "complete",
    }
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProcessingCapabilityState {
        Available => "available",
        Waiting => "waiting",
    }
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingFailure {
    pub class: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingArtifact {
    pub id: Uuid,
    pub role: String,
    pub media_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub download_url: String,
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingJob {
    pub id: Uuid,
    pub operation: ProcessingOperation,
    #[schema(required)]
    pub project_id: Option<Uuid>,
    #[schema(required)]
    pub result_project_id: Option<Uuid>,
    pub state: ProcessingJobState,
    pub phase: ProcessingPhase,
    pub cancellation_requested: bool,
    pub attempt_count: i32,
    #[schema(required)]
    pub processor_contract: Option<String>,
    #[schema(required)]
    pub failure: Option<ProcessingFailure>,
    pub artifacts: Vec<ProcessingArtifact>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[schema(required)]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingJobList {
    pub jobs: Vec<ProcessingJob>,
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingCapability {
    pub operation: ProcessingOperation,
    pub state: ProcessingCapabilityState,
    #[schema(required)]
    pub input_profile_selector: Option<ProcessingInputProfileSelector>,
    pub healthy_sessions: i64,
    pub active_slots: i64,
    pub active_jobs: i64,
    pub queued_jobs: i64,
    #[schema(required)]
    pub reason: Option<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingCapabilities {
    pub capabilities: Vec<ProcessingCapability>,
}

#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingInputProfile {
    pub id: String,
    pub label: crate::localized_text::LocalizedText,
    pub description: crate::localized_text::LocalizedText,
}

#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProcessingInputProfileSelector {
    pub label: crate::localized_text::LocalizedText,
    pub default_profile: String,
    pub profiles: Vec<ProcessingInputProfile>,
}

text_enum! {
    #[schema(rename_all = "snake_case")]
    pub enum ProjectProcessingCapabilityState {
        Available => "available",
        Waiting => "waiting",
        Inapplicable => "inapplicable",
    }
}

#[derive(Clone, serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectProcessingCapability {
    pub operation: ProcessingOperation,
    pub state: ProjectProcessingCapabilityState,
    #[schema(required)]
    pub reason: Option<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(crate) struct ProjectProcessingCapabilities {
    pub capabilities: Vec<ProjectProcessingCapability>,
}
