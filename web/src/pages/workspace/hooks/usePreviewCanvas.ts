import {
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  type MouseEvent as ReactMouseEvent
} from "react";
import { renderTypstVectorToCanvas } from "@/lib/typst";
import { renderPdfBytesToCanvas } from "@/lib/pdf";
import {
  clientPointToTypstPosition,
  type TypstDocumentPosition
} from "@/lib/typstSync";
import type { PreviewFitMode } from "@/pages/workspace/types";
import {
  applyPreviewZoom,
  deriveFitZoom,
  PREVIEW_MANUAL_MIN_ZOOM,
  PREVIEW_MAX_ZOOM
} from "@/pages/workspace/utils";
import {
  captureManualViewportAnchor,
  captureViewportAnchor,
  collectRenderedPages,
  FIT_ZOOM_SYNC_EPSILON,
  initialPreviewCanvasState,
  measurePageIndicator,
  previewCanvasReducer,
  previewPageScrollTarget,
  restoreManualViewportAnchor,
  restoreViewportAnchor,
  syncPreviewScrollbarWidth,
  type ManualViewportAnchor,
  type PreviewViewportAnchor
} from "@/pages/workspace/previewCanvasModel";

type UsePreviewCanvasParams = {
  typstRuntimeBaseUrl: string;
  showPreviewPanel: boolean;
  previewArtifactKind: "typst-vector" | "pdf";
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  typstMappingRevision: number | null;
  previewPixelPerPt: number;
  previewFitMode: PreviewFitMode;
  previewZoom: number;
  setPreviewZoom: (updater: number | ((current: number) => number)) => void;
  onRequestManualZoom?: (updater: (current: number) => number) => void;
  layoutKey: string;
  onRenderError: (message: string) => void;
  renderErrorFallback: string;
  initialViewportAnchor?: PreviewViewportAnchor | null;
  onViewportAnchorChange?: (anchor: PreviewViewportAnchor) => void;
  onTypstPreviewClick?: (
    position: TypstDocumentPosition,
    renderedMappingRevision: number | null
  ) => void;
};

export function usePreviewCanvas({
  typstRuntimeBaseUrl,
  showPreviewPanel,
  previewArtifactKind,
  vectorData,
  pdfData,
  typstMappingRevision,
  previewPixelPerPt,
  previewFitMode,
  previewZoom,
  setPreviewZoom,
  onRequestManualZoom,
  layoutKey,
  onRenderError,
  renderErrorFallback,
  initialViewportAnchor,
  onViewportAnchorChange,
  onTypstPreviewClick
}: UsePreviewCanvasParams) {
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const previewPanCleanupRef = useRef<(() => void) | null>(null);
  const previewPanMovedRef = useRef(false);
  const preferredPageIndexRef = useRef<number | null>(null);
  const pendingPreviewPositionRef = useRef<TypstDocumentPosition | null>(null);
  const lastRenderedArtifactRef = useRef<{
    kind: "typst-vector" | "pdf";
    pixelPerPt: number;
    bytes: Uint8Array;
    mappingRevision: number | null;
  } | null>(null);
  const manualViewportRef = useRef<ManualViewportAnchor>({ xCenterRatio: 0.5, yCenterRatio: 0.5 });
  const gestureLastScaleRef = useRef(1);
  const viewportAnchorRef = useRef<PreviewViewportAnchor>(initialViewportAnchor ?? { xRatio: 0, yRatio: 0 });
  const viewportAnchorHydratedRef = useRef(false);
  const [canvasState, dispatchCanvas] = useReducer(
    previewCanvasReducer,
    initialPreviewCanvasState
  );

  const readPreviewPreferences = useEffectEvent(() => ({
    fitMode: previewFitMode,
    zoom: previewZoom
  }));

  const reportRenderError = useEffectEvent((message: string) => {
    onRenderError(message);
  });

  const emitViewportAnchorFromEffect = useEffectEvent((frame: HTMLElement) => {
    if (collectRenderedPages(frame).length === 0) return;
    onViewportAnchorChange?.(viewportAnchorRef.current);
  });

  const requestManualZoom = useEffectEvent((nextZoom: number) => {
    if (onRequestManualZoom) {
      onRequestManualZoom(() => nextZoom);
      return;
    }
    setPreviewZoom(nextZoom);
  });

  const emitViewportAnchor = (frame: HTMLElement) => {
    if (collectRenderedPages(frame).length === 0) return;
    onViewportAnchorChange?.(viewportAnchorRef.current);
  };

  const currentPageIndicator = (frame: HTMLElement) => {
    const indicator = measurePageIndicator(frame, preferredPageIndexRef.current);
    if (indicator.pageTotal === 0) preferredPageIndexRef.current = null;
    return indicator;
  };

  const refreshPageIndicator = (frame: HTMLElement) => {
    dispatchCanvas({ type: "pages.measured", ...currentPageIndicator(frame) });
  };

  useEffect(() => {
    viewportAnchorRef.current = initialViewportAnchor ?? { xRatio: 0, yRatio: 0 };
    viewportAnchorHydratedRef.current = false;
  }, [initialViewportAnchor]);

  useEffect(() => {
    return () => {
      if (previewPanCleanupRef.current) {
        previewPanCleanupRef.current();
        previewPanCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    syncPreviewScrollbarWidth(frame);
    if (viewportAnchorHydratedRef.current) {
      viewportAnchorRef.current = captureViewportAnchor(frame);
    }
    if (viewportAnchorHydratedRef.current) {
      emitViewportAnchorFromEffect(frame);
    }
    const artifactBytes = previewArtifactKind === "typst-vector" ? vectorData : pdfData;
    const artifactMappingRevision =
      previewArtifactKind === "typst-vector" ? typstMappingRevision : null;
    if (!artifactBytes) {
      lastRenderedArtifactRef.current = null;
      frame.replaceChildren();
      dispatchCanvas({
        type: "render.cleared",
        ...currentPageIndicator(frame)
      });
      return;
    }
    const lastRenderedArtifact = lastRenderedArtifactRef.current;
    const alreadyRendered =
      lastRenderedArtifact?.kind === previewArtifactKind &&
      lastRenderedArtifact.pixelPerPt === previewPixelPerPt &&
      lastRenderedArtifact.bytes === artifactBytes &&
      lastRenderedArtifact.mappingRevision === artifactMappingRevision &&
      !!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas");
    if (alreadyRendered) {
      dispatchCanvas({
        type: "render.settled",
        mappingRevision: artifactMappingRevision,
        ...currentPageIndicator(frame)
      });
      return;
    }
    let cancelled = false;
    const preferencesAtRenderStart = readPreviewPreferences();
    if (preferencesAtRenderStart.fitMode === "manual") {
      manualViewportRef.current = captureManualViewportAnchor(frame);
    }
    dispatchCanvas({ type: "render.started" });
    const renderPromise =
      previewArtifactKind === "typst-vector"
        ? renderTypstVectorToCanvas(frame, artifactBytes, {
            pixelPerPt: previewPixelPerPt,
            runtimeBaseUrl: typstRuntimeBaseUrl,
          })
        : renderPdfBytesToCanvas(frame, artifactBytes, { pixelPerPt: previewPixelPerPt });
    renderPromise
      .then(() => {
        if (cancelled) return;
        lastRenderedArtifactRef.current = {
          kind: previewArtifactKind,
          pixelPerPt: previewPixelPerPt,
          bytes: artifactBytes,
          mappingRevision: artifactMappingRevision
        };
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const { fitMode, zoom: currentZoom } = readPreviewPreferences();
          const zoom = fitMode === "manual" ? currentZoom : deriveFitZoom(frame, pages, fitMode);
          applyPreviewZoom(frame, zoom);
          syncPreviewScrollbarWidth(frame);
          if (fitMode === "manual") {
            restoreManualViewportAnchor(frame, manualViewportRef.current);
            if (!viewportAnchorHydratedRef.current) {
              viewportAnchorHydratedRef.current = true;
            }
          } else {
            restoreViewportAnchor(frame, viewportAnchorRef.current);
            if (!viewportAnchorHydratedRef.current) {
              viewportAnchorHydratedRef.current = true;
            }
          }
          viewportAnchorRef.current = captureViewportAnchor(frame);
          emitViewportAnchorFromEffect(frame);
          if (fitMode !== "manual" && Math.abs(zoom - currentZoom) > FIT_ZOOM_SYNC_EPSILON) {
            setPreviewZoom(zoom);
          }
        }
        dispatchCanvas({
          type: "render.settled",
          mappingRevision: artifactMappingRevision,
          ...currentPageIndicator(frame)
        });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatchCanvas({
          type: "render.failed",
          ...currentPageIndicator(frame)
        });
        const message = err instanceof Error ? err.message : renderErrorFallback;
        reportRenderError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    typstRuntimeBaseUrl,
    previewArtifactKind,
    previewPixelPerPt,
    renderErrorFallback,
    setPreviewZoom,
    showPreviewPanel,
    vectorData,
    pdfData,
    typstMappingRevision
  ]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
    if (!pages) return;
    const manualMode = previewFitMode === "manual";
    if (manualMode) {
      manualViewportRef.current = captureManualViewportAnchor(frame);
    } else if (viewportAnchorHydratedRef.current) {
      viewportAnchorRef.current = captureViewportAnchor(frame);
    }
    const zoom = manualMode ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
    applyPreviewZoom(frame, zoom);
    syncPreviewScrollbarWidth(frame);
    if (manualMode) {
      restoreManualViewportAnchor(frame, manualViewportRef.current);
    } else {
      restoreViewportAnchor(frame, viewportAnchorRef.current);
    }
    refreshPageIndicator(frame);
    viewportAnchorRef.current = captureViewportAnchor(frame);
    if (viewportAnchorHydratedRef.current) {
      emitViewportAnchorFromEffect(frame);
    }
    if (!manualMode && Math.abs(zoom - previewZoom) > FIT_ZOOM_SYNC_EPSILON) {
      setPreviewZoom(zoom);
    }
  }, [
    canvasState.renderRevision,
    layoutKey,
    previewFitMode,
    previewZoom,
    setPreviewZoom
  ]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      syncPreviewScrollbarWidth(frame);
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages || previewFitMode === "manual") return;
      if (viewportAnchorHydratedRef.current) {
        viewportAnchorRef.current = captureViewportAnchor(frame);
      }
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      syncPreviewScrollbarWidth(frame);
      restoreViewportAnchor(frame, viewportAnchorRef.current);
      refreshPageIndicator(frame);
      viewportAnchorRef.current = captureViewportAnchor(frame);
      if (viewportAnchorHydratedRef.current) {
        emitViewportAnchorFromEffect(frame);
      }
      setPreviewZoom((current) =>
        Math.abs(current - zoom) > FIT_ZOOM_SYNC_EPSILON ? zoom : current
      );
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewFitMode, setPreviewZoom, showPreviewPanel]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const setGestureAnchor = (clientX: number, clientY: number) => {
      const rect = frame.getBoundingClientRect();
      const localX = Math.max(0, Math.min(frame.clientWidth, clientX - rect.left));
      const localY = Math.max(0, Math.min(frame.clientHeight, clientY - rect.top));
      manualViewportRef.current = {
        xCenterRatio:
          frame.scrollWidth > 0
            ? Math.min(1, Math.max(0, (frame.scrollLeft + localX) / frame.scrollWidth))
            : 0.5,
        yCenterRatio:
          frame.scrollHeight > 0
            ? Math.min(1, Math.max(0, (frame.scrollTop + localY) / frame.scrollHeight))
            : 0.5
      };
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setGestureAnchor(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * 0.0025);
      const next = Math.min(
        PREVIEW_MAX_ZOOM,
        Math.max(
          PREVIEW_MANUAL_MIN_ZOOM,
          readPreviewPreferences().zoom * factor
        )
      );
      requestManualZoom(next);
    };
    const onGestureStart = (event: Event) => {
      const gestureEvent = event as Event & { scale?: number; clientX?: number; clientY?: number };
      gestureLastScaleRef.current = gestureEvent.scale && Number.isFinite(gestureEvent.scale) ? gestureEvent.scale : 1;
      if (typeof gestureEvent.clientX === "number" && typeof gestureEvent.clientY === "number") {
        setGestureAnchor(gestureEvent.clientX, gestureEvent.clientY);
      }
      event.preventDefault();
    };
    const onGestureChange = (event: Event) => {
      const gestureEvent = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const currentScale =
        gestureEvent.scale && Number.isFinite(gestureEvent.scale) ? gestureEvent.scale : gestureLastScaleRef.current;
      const prevScale = gestureLastScaleRef.current || 1;
      const factor = prevScale > 0 ? currentScale / prevScale : 1;
      gestureLastScaleRef.current = currentScale;
      if (typeof gestureEvent.clientX === "number" && typeof gestureEvent.clientY === "number") {
        setGestureAnchor(gestureEvent.clientX, gestureEvent.clientY);
      }
      const next = Math.min(
        PREVIEW_MAX_ZOOM,
        Math.max(
          PREVIEW_MANUAL_MIN_ZOOM,
          readPreviewPreferences().zoom * factor
        )
      );
      requestManualZoom(next);
      event.preventDefault();
    };

    frame.addEventListener("wheel", onWheel, { passive: false });
    frame.addEventListener("gesturestart", onGestureStart as EventListener, { passive: false });
    frame.addEventListener("gesturechange", onGestureChange as EventListener, { passive: false });
    return () => {
      frame.removeEventListener("wheel", onWheel);
      frame.removeEventListener("gesturestart", onGestureStart as EventListener);
      frame.removeEventListener("gesturechange", onGestureChange as EventListener);
    };
  }, [showPreviewPanel]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const onScroll = () => {
      if (viewportAnchorHydratedRef.current) {
        viewportAnchorRef.current = captureViewportAnchor(frame);
        emitViewportAnchorFromEffect(frame);
      }
      refreshPageIndicator(frame);
    };
    frame.addEventListener("scroll", onScroll, { passive: true });
    if (viewportAnchorHydratedRef.current) {
      viewportAnchorRef.current = captureViewportAnchor(frame);
      emitViewportAnchorFromEffect(frame);
    }
    refreshPageIndicator(frame);
    return () => frame.removeEventListener("scroll", onScroll);
  }, [canvasState.renderRevision]);

  function beginPreviewPan(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages");
    if (!pages) return;
    const canPanX = frame.scrollWidth > frame.clientWidth + 1;
    const canPanY = frame.scrollHeight > frame.clientHeight + 1;
    if (!canPanX && !canPanY) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const initialScrollLeft = frame.scrollLeft;
    const initialScrollTop = frame.scrollTop;
    previewPanMovedRef.current = false;
    dispatchCanvas({ type: "panning.changed", active: true });
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
        previewPanMovedRef.current = true;
      }
      if (canPanX) frame.scrollLeft = initialScrollLeft - deltaX;
      if (canPanY) frame.scrollTop = initialScrollTop - deltaY;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      previewPanCleanupRef.current = null;
      dispatchCanvas({ type: "panning.changed", active: false });
      if (previewPanMovedRef.current) {
        window.setTimeout(() => {
          previewPanMovedRef.current = false;
        }, 0);
      }
    };
    previewPanCleanupRef.current = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handlePreviewClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (previewPanMovedRef.current || previewArtifactKind !== "typst-vector") return;
    const target = event.target as HTMLElement | null;
    const page = target?.closest(".typst-page") as HTMLElement | null;
    if (!page || !event.currentTarget.contains(page)) return;
    const renderedPages = collectRenderedPages(event.currentTarget);
    const pageIndex = renderedPages.indexOf(page);
    if (pageIndex >= 0) {
      preferredPageIndexRef.current = pageIndex;
      dispatchCanvas({
        type: "pages.measured",
        pageCurrent: pageIndex + 1,
        pageTotal: renderedPages.length
      });
    }
    const position = clientPointToTypstPosition({
      pageOffset: Number.parseInt(page.dataset.typstPageOffset || "", 10),
      clientX: event.clientX,
      clientY: event.clientY,
      rect: page.getBoundingClientRect(),
      pageWidth: Number.parseFloat(page.dataset.baseWidth || ""),
      pageHeight: Number.parseFloat(page.dataset.baseHeight || "")
    });
    if (position) {
      onTypstPreviewClick?.(position, canvasState.renderedMappingRevision);
    }
  }

  function jumpToPreviewPage(pageNumber: number) {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = collectRenderedPages(frame);
    if (pages.length === 0) return;
    const targetIndex = Math.min(pages.length - 1, Math.max(0, Math.floor(pageNumber) - 1));
    const target = pages[targetIndex];
    preferredPageIndexRef.current = targetIndex;
    frame.scrollTop = previewPageScrollTarget(frame, target);
    viewportAnchorRef.current = captureViewportAnchor(frame);
    emitViewportAnchor(frame);
    refreshPageIndicator(frame);
  }

  function jumpToPreviewPosition(position: TypstDocumentPosition) {
    const frame = canvasPreviewRef.current;
    if (!frame) {
      pendingPreviewPositionRef.current = position;
      return;
    }
    const pages = collectRenderedPages(frame);
    const matchingIndex = pages.findIndex(
      (page) => Number.parseInt(page.dataset.typstPageOffset || "", 10) === position.pageOffset
    );
    const targetIndex = matchingIndex >= 0 ? matchingIndex : position.pageOffset;
    const target = pages[targetIndex];
    if (!target) {
      pendingPreviewPositionRef.current = position;
      return;
    }
    pendingPreviewPositionRef.current = null;
    preferredPageIndexRef.current = targetIndex;
    const frameRect = frame.getBoundingClientRect();
    const pageRect = target.getBoundingClientRect();
    const pageWidth = Number.parseFloat(target.dataset.baseWidth || "") || pageRect.width;
    const pageHeight = Number.parseFloat(target.dataset.baseHeight || "") || pageRect.height;
    const pageLeft = frame.scrollLeft + pageRect.left - frameRect.left - frame.clientLeft;
    const pageTop = frame.scrollTop + pageRect.top - frameRect.top - frame.clientTop;
    const pointLeft = pageLeft + (position.x / Math.max(1, pageWidth)) * pageRect.width;
    const pointTop = pageTop + (position.y / Math.max(1, pageHeight)) * pageRect.height;
    const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
    const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
    frame.scrollLeft = Math.min(maxLeft, Math.max(0, pointLeft - frame.clientWidth / 2));
    frame.scrollTop = Math.min(maxTop, Math.max(0, pointTop - frame.clientHeight / 2));
    viewportAnchorRef.current = captureViewportAnchor(frame);
    emitViewportAnchor(frame);
    refreshPageIndicator(frame);
  }

  const fulfillPendingPreviewJump = useEffectEvent(() => {
    const pending = pendingPreviewPositionRef.current;
    if (!pending || !showPreviewPanel || canvasState.pageTotal === 0) return;
    jumpToPreviewPosition(pending);
  });

  useEffect(() => {
    fulfillPendingPreviewJump();
  }, [canvasState.pageTotal, canvasState.renderRevision, showPreviewPanel]);

  return {
    canvasPreviewRef,
    previewRenderTick: canvasState.renderRevision,
    previewIsPanning: canvasState.isPanning,
    previewRendering: canvasState.renderStatus === "rendering",
    hasPreviewPage: canvasState.pageTotal > 0,
    previewPageCurrent: canvasState.pageCurrent,
    previewPageTotal: canvasState.pageTotal,
    renderedTypstMappingRevision: canvasState.renderedMappingRevision,
    jumpToPreviewPage,
    jumpToPreviewPosition,
    handlePreviewClick,
    beginPreviewPan
  };
}
