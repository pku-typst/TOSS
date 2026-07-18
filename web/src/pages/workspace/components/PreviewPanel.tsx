import { useState } from "react";
import "@/pages/workspace/preview.css";
import {
  CloudCog,
  Download,
  LoaderCircle,
  Maximize2,
  MoveHorizontal,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { UiButton, UiIconButton, UiInput } from "@/components/ui";
import type { CompileDiagnostic } from "@/lib/typst";
import type { Translator } from "@/lib/i18n";

function boundedPercent(loaded: number, total: number): number | null {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((100 * loaded) / total)));
}

export function hasCompilationFailure(
  diagnostics: readonly CompileDiagnostic[],
  errors: readonly string[],
) {
  return (
    errors.length > 0 ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  );
}

export function PreviewPanel({
  editorRatio,
  previewFitMode,
  previewPercent,
  previewPageCurrent,
  previewPageTotal,
  canDownloadPdf,
  pdfExportActive,
  compileRuntimeStatus,
  compileKind,
  workspaceSyncPending,
  compileActive,
  previewRendering,
  previewReplacing,
  previewOutdated,
  assetHydrationProgress,
  previewIsPanning,
  compileDiagnostics,
  compileErrors,
  hasPreviewPage,
  canvasPreviewRef,
  onBeginPreviewPan,
  onPreviewClick,
  onSetFitWholePage,
  onSetFitPageWidth,
  onDecreaseZoom,
  onIncreaseZoom,
  onJumpToPage,
  onDownloadPdf,
  backgroundBuild,
  onJumpToDiagnostic,
  t
}: {
  editorRatio: number;
  previewFitMode: "manual" | "page" | "width";
  previewPercent: number;
  previewPageCurrent: number;
  previewPageTotal: number;
  canDownloadPdf: boolean;
  pdfExportActive: boolean;
  compileRuntimeStatus: {
    stage: "downloading-compiler" | "downloading-package" | "compiling" | "ready" | "idle";
    loadedBytes?: number;
    totalBytes?: number;
    packageSpec?: string;
  };
  compileKind: "typst" | "latex";
  workspaceSyncPending: boolean;
  compileActive: boolean;
  previewRendering: boolean;
  previewReplacing: boolean;
  previewOutdated: boolean;
  assetHydrationProgress: {
    active: boolean;
    loaded: number;
    total: number;
    loadedBytes: number;
    totalBytes: number;
  };
  previewIsPanning: boolean;
  compileDiagnostics: CompileDiagnostic[];
  compileErrors: string[];
  hasPreviewPage: boolean;
  canvasPreviewRef: React.RefObject<HTMLDivElement | null>;
  onBeginPreviewPan: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPreviewClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSetFitWholePage: () => void;
  onSetFitPageWidth: () => void;
  onDecreaseZoom: () => void;
  onIncreaseZoom: () => void;
  onJumpToPage: (pageNumber: number) => void;
  onDownloadPdf: () => void;
  backgroundBuild: {
    visible: boolean;
    state: "available" | "waiting" | "loading" | "error";
    reason: string | null;
    submit: () => void;
    pending: boolean;
    error: string | null;
  };
  onJumpToDiagnostic: (diagnostic: CompileDiagnostic) => void;
  t: Translator;
}) {
  const [pageJumpInput, setPageJumpInput] = useState("");
  const pageJumpPopoverId = "preview-page-jump";
  const hasCompileFailure = hasCompilationFailure(
    compileDiagnostics,
    compileErrors,
  );
  const showStaleOverlay = hasCompileFailure && hasPreviewPage;
  const showEmptyErrorState = hasCompileFailure && !hasPreviewPage;
  const showRefreshOverlay =
    hasPreviewPage &&
    !hasCompileFailure &&
    (previewOutdated || compileActive || previewReplacing);
  const assetHydrationPercent =
    assetHydrationProgress.totalBytes > 0
      ? boundedPercent(assetHydrationProgress.loadedBytes, assetHydrationProgress.totalBytes)
      : boundedPercent(assetHydrationProgress.loaded, assetHydrationProgress.total);
  const compilerDownloadPercent =
    compileRuntimeStatus.stage === "downloading-compiler" &&
    compileRuntimeStatus.totalBytes &&
    compileRuntimeStatus.totalBytes > 0
      ? boundedPercent(compileRuntimeStatus.loadedBytes || 0, compileRuntimeStatus.totalBytes)
      : null;
  const compilerPreparing = compileRuntimeStatus.stage === "downloading-compiler";
  const packageDownloading = compileRuntimeStatus.stage === "downloading-package";
  const runtimePreparing = compilerPreparing || packageDownloading;
  const initialLoadingPhase = compilerPreparing
    ? 0
    : previewRendering
      ? 2
      : compileActive || compileRuntimeStatus.stage === "compiling"
        ? 1
        : 0;
  const showInitialLoadingState = !hasPreviewPage && !showEmptyErrorState;
  const initialLoadingLabel = workspaceSyncPending
    ? t("preview.loadingProject")
    : assetHydrationProgress.active
      ? t("preview.loadingProjectAssets", {
          loaded: assetHydrationProgress.loaded,
          total: assetHydrationProgress.total
        })
      : packageDownloading
        ? t("preview.loadingPackage", {
            package: compileRuntimeStatus.packageSpec ?? "@preview"
          })
        : compilerPreparing
          ? compileKind === "latex"
            ? t("preview.loadingCompilerLatex")
            : t("preview.loadingCompiler")
          : previewRendering
            ? t("preview.rendering")
            : compileActive || compileRuntimeStatus.stage === "compiling"
              ? compileKind === "latex"
                ? t("preview.compilingLatex")
                : t("preview.compiling")
              : t("preview.preparing");
  const initialProgress = assetHydrationProgress.active
    ? assetHydrationPercent
    : compilerPreparing
      ? compilerDownloadPercent
      : null;
  const initialProgressText = assetHydrationProgress.active
    ? assetHydrationPercent !== null
      ? `${assetHydrationPercent}%`
      : `${assetHydrationProgress.loaded}/${assetHydrationProgress.total}`
    : compilerPreparing
      ? compilerDownloadPercent !== null
        ? `${compilerDownloadPercent}%`
        : compileRuntimeStatus.loadedBytes
          ? `${Math.round(compileRuntimeStatus.loadedBytes / 1024)} KB`
          : ""
      : "";
  const previewTitle = t("workspace.preview");
  const previewPageLabel =
    previewPageTotal > 0
      ? t("preview.pageIndicator", {
          current: previewPageCurrent,
          total: previewPageTotal
        })
      : null;
  const backgroundBuildLabel = backgroundBuild.pending
    ? t("processing.submitting")
    : backgroundBuild.state === "waiting"
      ? t("processing.buildWaiting")
      : backgroundBuild.state === "error"
        ? t("processing.capabilitiesFailed")
        : backgroundBuild.state === "loading"
          ? t("processing.checkingAvailability")
          : t("processing.buildPdf");

  function submitPageJump() {
    const parsed = Number.parseInt(pageJumpInput, 10);
    if (!Number.isFinite(parsed)) return;
    onJumpToPage(Math.min(previewPageTotal, Math.max(1, parsed)));
    document.getElementById(pageJumpPopoverId)?.hidePopover();
  }

  return (
    <aside className="panel panel-preview" style={{ flex: `${1 - editorRatio} 1 0`, minWidth: 280 }}>
      <div className="panel-header workspace-main-header">
        <div className="preview-title-group">
          <h2>{previewTitle}</h2>
          {previewPageLabel && (
            <div className="preview-page-jump-wrap">
              <nve-button
                role="button"
                container="flat"
                size="sm"
                className="preview-page-indicator"
                popovertarget={pageJumpPopoverId}
                onClick={() => {
                  setPageJumpInput(String(previewPageCurrent));
                }}
              >
                {previewPageLabel}
              </nve-button>
              <nve-toggletip
                id={pageJumpPopoverId}
                className="preview-page-popover"
                position="bottom"
                alignment="start"
              >
                <div nve-layout="column gap:sm">
                  <strong>{t("preview.goToPage")}</strong>
                  <div className="preview-page-popover-row">
                    <UiInput
                      value={pageJumpInput}
                      onChange={(event) => setPageJumpInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitPageJump();
                      }}
                      inputMode="numeric"
                      aria-label={t("preview.pageIndicator", {
                        current: previewPageCurrent,
                        total: previewPageTotal
                      })}
                    />
                    <UiButton size="sm" variant="primary" onClick={submitPageJump}>
                      {t("preview.goAction")}
                    </UiButton>
                  </div>
                </div>
              </nve-toggletip>
            </div>
          )}
        </div>
        <nve-toolbar className="panel-toolbar" container="inset" content="wrap">
          <UiIconButton
            tooltip={t("preview.fitWhole")}
            label={t("preview.fitWhole")}
            className={previewFitMode === "page" ? "active" : ""}
            onClick={onSetFitWholePage}
          >
            <Maximize2 size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={t("preview.fitWidth")}
            label={t("preview.fitWidth")}
            className={previewFitMode === "width" ? "active" : ""}
            onClick={onSetFitPageWidth}
          >
            <MoveHorizontal size={16} />
          </UiIconButton>
          <UiIconButton tooltip={t("preview.zoomOut")} label={t("preview.zoomOut")} onClick={onDecreaseZoom}>
            <ZoomOut size={16} />
          </UiIconButton>
          <span className="zoom-indicator">{previewPercent}%</span>
          <UiIconButton tooltip={t("preview.zoomIn")} label={t("preview.zoomIn")} onClick={onIncreaseZoom}>
            <ZoomIn size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={pdfExportActive ? t("preview.generatingPdf") : t("preview.downloadPdf")}
            label={pdfExportActive ? t("preview.generatingPdf") : t("preview.downloadPdf")}
            onClick={onDownloadPdf}
            disabled={!canDownloadPdf || pdfExportActive}
          >
            <Download size={16} />
          </UiIconButton>
          {backgroundBuild.visible && (
            <UiIconButton
              tooltip={backgroundBuildLabel}
              label={backgroundBuildLabel}
              onClick={backgroundBuild.submit}
              disabled={
                backgroundBuild.pending ||
                backgroundBuild.state === "loading" ||
                backgroundBuild.state === "error"
              }
            >
              {backgroundBuild.pending ? (
                <LoaderCircle className="spin" size={16} aria-hidden />
              ) : (
                <CloudCog size={16} aria-hidden />
              )}
            </UiIconButton>
          )}
        </nve-toolbar>
      </div>
      <div className="panel-content flush preview-panel-content">
        <div className="preview-stage">
          <div className="preview-runtime-overlay" aria-live="polite">
            {backgroundBuild.error && (
              <nve-alert className="preview-runtime-status" status="danger">
                <strong>{t("processing.submitFailed")}</strong>
                <span>{backgroundBuild.error}</span>
              </nve-alert>
            )}
            {hasPreviewPage && workspaceSyncPending && (
              <nve-alert className="preview-runtime-status" status="pending">
                <strong>{t("preview.loadingProject")}</strong>
              </nve-alert>
            )}
            {hasPreviewPage && assetHydrationProgress.active && (
              <nve-alert className="preview-runtime-status" status="running">
                <strong>
                  {t("preview.loadingProjectAssets", {
                    loaded: assetHydrationProgress.loaded,
                    total: assetHydrationProgress.total
                  })}
                </strong>
                <span slot="actions">
                  {assetHydrationProgress.totalBytes > 0 && assetHydrationPercent !== null
                    ? `${assetHydrationPercent}%`
                    : `${assetHydrationProgress.loaded}/${assetHydrationProgress.total}`}
                </span>
                <nve-progress-bar
                  slot="content"
                  status="accent"
                  value={assetHydrationPercent ?? undefined}
                />
              </nve-alert>
            )}
            {hasPreviewPage && (compileActive || runtimePreparing) && (
              <nve-alert className="preview-runtime-status" status="running">
                <strong>
                  {compileRuntimeStatus.stage === "downloading-package"
                    ? t("preview.loadingPackage", {
                        package: compileRuntimeStatus.packageSpec ?? "@preview"
                      })
                    : compileRuntimeStatus.stage === "downloading-compiler"
                      ? compileKind === "latex"
                        ? t("preview.loadingCompilerLatex")
                        : t("preview.loadingCompiler")
                      : compileKind === "latex"
                        ? t("preview.compilingLatex")
                        : t("preview.compiling")}
                </strong>
                {compileRuntimeStatus.stage === "downloading-compiler" && (
                  <span slot="actions">
                    {compilerDownloadPercent !== null
                      ? `${compilerDownloadPercent}%`
                      : `${Math.round((compileRuntimeStatus.loadedBytes || 0) / 1024)} KB`}
                  </span>
                )}
                {compileRuntimeStatus.stage === "downloading-compiler" && (
                  <nve-progress-bar
                    slot="content"
                    status="accent"
                    value={compilerDownloadPercent ?? undefined}
                  />
                )}
              </nve-alert>
            )}
            {hasPreviewPage && previewRendering && !compileActive && (
              <nve-alert className="preview-runtime-status" status="running">
                <strong>{t("preview.rendering")}</strong>
              </nve-alert>
            )}
            {pdfExportActive && (
              <nve-alert className="preview-runtime-status" status="running">
                <strong>{t("preview.generatingPdf")}</strong>
              </nve-alert>
            )}
          </div>
          <div
            ref={canvasPreviewRef}
            className={`pdf-frame preview-fit-${previewFitMode} ${previewIsPanning ? "is-panning" : ""}`}
            onMouseDown={onBeginPreviewPan}
            onClick={onPreviewClick}
          />
          <div
            className={`preview-refresh-overlay${showRefreshOverlay ? " active" : ""}`}
            aria-hidden
          />
          {showInitialLoadingState && (
            <div className="preview-initial-loading" role="status" aria-live="polite">
              <div className="preview-loading-shell">
                <div className="preview-loading-sheet" aria-hidden>
                  <span className="preview-loading-line title" />
                  <span className="preview-loading-line" />
                  <span className="preview-loading-line medium" />
                  <span className="preview-loading-line" />
                  <span className="preview-loading-line short" />
                </div>
                <div className="preview-loading-copy">
                  <LoaderCircle className="preview-loading-spin" size={20} aria-hidden />
                  <strong>{initialLoadingLabel}</strong>
                  {initialLoadingPhase === 0 && !workspaceSyncPending && !assetHydrationProgress.active && (
                    <span>{t("preview.firstLoadHint")}</span>
                  )}
                </div>
                {(initialProgress !== null || initialProgressText) && (
                  <div className="preview-loading-progress">
                    <nve-progress-bar status="accent" value={initialProgress ?? undefined} />
                    <span>{initialProgressText}</span>
                  </div>
                )}
                <div className="preview-loading-steps" aria-hidden>
                  {[t("preview.stageRuntime"), t("preview.stageCompile"), t("preview.stageRender")].map(
                    (label, index) => (
                      <span
                        key={label}
                        className={
                          index < initialLoadingPhase
                            ? "complete"
                            : index === initialLoadingPhase
                              ? "active"
                              : "pending"
                        }
                      >
                        <i />
                        {label}
                      </span>
                    )
                  )}
                </div>
              </div>
            </div>
          )}
          {showStaleOverlay && (
            <div className="preview-stale-overlay">
              <strong>{t("preview.staleTitle")}</strong>
              <span>{t("preview.staleHint")}</span>
            </div>
          )}
          {showEmptyErrorState && (
            <div className="preview-empty-error">
              <strong>{t("preview.failedTitle")}</strong>
              <span>{t("preview.failedHint")}</span>
            </div>
          )}
        </div>
        {compileDiagnostics.length > 0 && (
          <div className="panel-inline-error diagnostics">
            {compileDiagnostics.map((diagnostic, index) => (
              <nve-alert
                key={`${diagnostic.raw}-${index}`}
                className="diagnostic-item"
                status={
                  diagnostic.severity === "error"
                    ? "danger"
                    : diagnostic.severity === "warning"
                      ? "warning"
                      : "accent"
                }
              >
                <span className="diagnostic-main selectable-text">
                  {diagnostic.path
                    ? `${diagnostic.path}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}`
                    : t("workspace.diagnosticScope")}
                  {" — "}
                  {diagnostic.message}
                </span>
                <UiButton
                  slot="actions"
                  variant="ghost"
                  size="sm"
                  onClick={() => onJumpToDiagnostic(diagnostic)}
                >
                  {t("preview.goAction")}
                </UiButton>
              </nve-alert>
            ))}
          </div>
        )}
        {compileDiagnostics.length === 0 && compileErrors.length > 0 && (
          <nve-alert className="panel-inline-error compile-error-alert" status="danger">
            {compileErrors.join("; ")}
          </nve-alert>
        )}
      </div>
    </aside>
  );
}
