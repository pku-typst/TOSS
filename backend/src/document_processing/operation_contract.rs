//! Closed contracts for Core-known durable processing operations.

use super::ProcessingOperation;

pub(super) const PPTX_MEDIA_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
pub(super) const PROJECT_BUNDLE_MEDIA_TYPE: &str = "application/vnd.toss.project-bundle+zip";
pub(super) const TYPST_PROJECT_BUNDLE_MEDIA_TYPE: &str =
    "application/vnd.toss.typst-project-bundle+zip";
pub(super) const WORKSPACE_BUNDLE_MEDIA_TYPE: &str = "application/vnd.toss.workspace-bundle+zip";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ArtifactSizeClass {
    Output,
    Diagnostic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ArtifactContract {
    pub role: &'static str,
    pub media_type: &'static str,
    pub filename_suffix: &'static str,
    pub size_class: ArtifactSizeClass,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum FinalizationKind {
    PdfArtifacts,
    PptxArtifacts,
    TypstWorkspace,
}

pub(super) struct OperationContract {
    pub input_schema: &'static str,
    pub input_media_type: &'static str,
    pub artifacts: &'static [ArtifactContract],
    pub finalization: FinalizationKind,
}

const LATEX_ARTIFACTS: &[ArtifactContract] = &[
    ArtifactContract {
        role: "pdf",
        media_type: "application/pdf",
        filename_suffix: ".pdf",
        size_class: ArtifactSizeClass::Output,
        required: true,
    },
    ArtifactContract {
        role: "log",
        media_type: "text/plain",
        filename_suffix: ".log",
        size_class: ArtifactSizeClass::Diagnostic,
        required: false,
    },
];

const PPTX_EXPORT_ARTIFACTS: &[ArtifactContract] = &[
    ArtifactContract {
        role: "pptx",
        media_type: PPTX_MEDIA_TYPE,
        filename_suffix: ".pptx",
        size_class: ArtifactSizeClass::Output,
        required: true,
    },
    ArtifactContract {
        role: "report",
        media_type: "application/json",
        filename_suffix: ".json",
        size_class: ArtifactSizeClass::Diagnostic,
        required: true,
    },
];

const PPTX_IMPORT_ARTIFACTS: &[ArtifactContract] = &[
    ArtifactContract {
        role: "workspace",
        media_type: WORKSPACE_BUNDLE_MEDIA_TYPE,
        filename_suffix: ".zip",
        size_class: ArtifactSizeClass::Output,
        required: true,
    },
    ArtifactContract {
        role: "report",
        media_type: "application/json",
        filename_suffix: ".json",
        size_class: ArtifactSizeClass::Diagnostic,
        required: true,
    },
];

impl ProcessingOperation {
    pub(super) const fn contract(self) -> &'static OperationContract {
        match self {
            Self::LatexCompilePdfV1 => &OperationContract {
                input_schema: "project-bundle/v1",
                input_media_type: PROJECT_BUNDLE_MEDIA_TYPE,
                artifacts: LATEX_ARTIFACTS,
                finalization: FinalizationKind::PdfArtifacts,
            },
            Self::TypstExportPptxV1 => &OperationContract {
                input_schema: "typst-project-bundle/v1",
                input_media_type: TYPST_PROJECT_BUNDLE_MEDIA_TYPE,
                artifacts: PPTX_EXPORT_ARTIFACTS,
                finalization: FinalizationKind::PptxArtifacts,
            },
            Self::PptxImportTypstV1 => &OperationContract {
                input_schema: "pptx-input/v1",
                input_media_type: PPTX_MEDIA_TYPE,
                artifacts: PPTX_IMPORT_ARTIFACTS,
                finalization: FinalizationKind::TypstWorkspace,
            },
        }
    }
}

impl OperationContract {
    pub(super) fn artifact(&self, role: &str) -> Option<&ArtifactContract> {
        self.artifacts.iter().find(|artifact| artifact.role == role)
    }
}
