import { useEffect, useRef, type RefObject } from "react";
import { uploadProjectThumbnail } from "@/lib/api";
import { buildTopPreviewThumbnail } from "@/pages/workspace/utils";

type UseWorkspacePreviewThumbnailInput = {
  projectId: string;
  workspaceLoaded: boolean;
  revisionMode: boolean;
  previewVisible: boolean;
  authenticated: boolean;
  previewReady: boolean;
  previewRenderTick: number;
  compileErrorCount: number;
  compileDiagnosticCount: number;
  previewContainerRef: RefObject<HTMLDivElement | null>;
};

export function useWorkspacePreviewThumbnail({
  projectId,
  workspaceLoaded,
  revisionMode,
  previewVisible,
  authenticated,
  previewReady,
  previewRenderTick,
  compileErrorCount,
  compileDiagnosticCount,
  previewContainerRef
}: UseWorkspacePreviewThumbnailInput) {
  const uploadTimerRef = useRef<number | null>(null);
  const lastUploadedThumbnailRef = useRef("");

  useEffect(() => {
    if (
      !projectId ||
      !workspaceLoaded ||
      revisionMode ||
      !previewVisible ||
      !authenticated ||
      !previewReady ||
      compileDiagnosticCount > 0 ||
      compileErrorCount > 0
    ) {
      return;
    }
    const previewContainer = previewContainerRef.current;
    const firstCanvas = previewContainer?.querySelector(
      ".pdf-pages canvas"
    ) as HTMLCanvasElement | null;
    if (!firstCanvas) return;

    if (uploadTimerRef.current !== null) {
      window.clearTimeout(uploadTimerRef.current);
    }
    uploadTimerRef.current = window.setTimeout(() => {
      const latestCanvas = (previewContainerRef.current?.querySelector(
        ".pdf-pages canvas"
      ) ?? firstCanvas) as HTMLCanvasElement | null;
      if (!latestCanvas) return;
      const dataUrl = buildTopPreviewThumbnail(latestCanvas);
      const base64 = dataUrl.split(",")[1] || "";
      if (!base64) return;
      const digest = `${projectId}:${base64.length}:${base64.slice(0, 128)}`;
      if (digest === lastUploadedThumbnailRef.current) return;
      void uploadProjectThumbnail(projectId, {
        content_base64: base64,
        content_type: "image/png"
      })
        .then(() => {
          lastUploadedThumbnailRef.current = digest;
        })
        .catch(() => undefined);
    }, 1200);

    return () => {
      if (uploadTimerRef.current !== null) {
        window.clearTimeout(uploadTimerRef.current);
        uploadTimerRef.current = null;
      }
    };
  }, [
    authenticated,
    compileDiagnosticCount,
    compileErrorCount,
    previewContainerRef,
    previewReady,
    previewRenderTick,
    previewVisible,
    projectId,
    revisionMode,
    workspaceLoaded
  ]);
}
