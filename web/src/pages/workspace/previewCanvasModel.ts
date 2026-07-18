export type PreviewViewportAnchor = {
  xRatio: number;
  yRatio: number;
};

export type ManualViewportAnchor = {
  xCenterRatio: number;
  yCenterRatio: number;
};

export type PreviewCanvasState = {
  renderRevision: number;
  renderStatus: "idle" | "rendering" | "ready" | "failed";
  pageCurrent: number;
  pageTotal: number;
  renderedMappingRevision: number | null;
  isPanning: boolean;
};

export type PreviewCanvasEvent =
  | { type: "render.started" }
  | { type: "mapping.changed"; mappingRevision: number | null }
  | {
      type: "render.cleared";
      pageCurrent: number;
      pageTotal: number;
    }
  | {
      type: "render.settled";
      pageCurrent: number;
      pageTotal: number;
      mappingRevision: number | null;
    }
  | {
      type: "render.failed";
      pageCurrent: number;
      pageTotal: number;
    }
  | { type: "pages.measured"; pageCurrent: number; pageTotal: number }
  | { type: "panning.changed"; active: boolean };

export const initialPreviewCanvasState: PreviewCanvasState = {
  renderRevision: 0,
  renderStatus: "idle",
  pageCurrent: 0,
  pageTotal: 0,
  renderedMappingRevision: null,
  isPanning: false
};

export function previewCanvasReducer(
  state: PreviewCanvasState,
  event: PreviewCanvasEvent
): PreviewCanvasState {
  switch (event.type) {
    case "mapping.changed":
      if (state.renderedMappingRevision === event.mappingRevision) return state;
      return {
        ...state,
        renderedMappingRevision: event.mappingRevision
      };
    case "render.started":
      return {
        ...state,
        renderStatus: "rendering",
        renderedMappingRevision: null
      };
    case "render.cleared":
      return {
        ...state,
        renderRevision: state.renderRevision + 1,
        renderStatus: "idle",
        pageCurrent: event.pageCurrent,
        pageTotal: event.pageTotal,
        renderedMappingRevision: null
      };
    case "render.settled":
      return {
        ...state,
        renderRevision: state.renderRevision + 1,
        renderStatus: "ready",
        pageCurrent: event.pageCurrent,
        pageTotal: event.pageTotal,
        renderedMappingRevision: event.mappingRevision
      };
    case "render.failed":
      return {
        ...state,
        renderStatus: "failed",
        pageCurrent: event.pageCurrent,
        pageTotal: event.pageTotal,
        renderedMappingRevision: null
      };
    case "pages.measured":
      if (
        state.pageCurrent === event.pageCurrent &&
        state.pageTotal === event.pageTotal
      ) {
        return state;
      }
      return {
        ...state,
        pageCurrent: event.pageCurrent,
        pageTotal: event.pageTotal
      };
    case "panning.changed":
      if (state.isPanning === event.active) return state;
      return { ...state, isPanning: event.active };
  }
}

export const FIT_ZOOM_SYNC_EPSILON = 0.03;

function previewScrollbarWidth(frame: HTMLElement) {
  const style = window.getComputedStyle(frame);
  const borderLeft = Number.parseFloat(style.borderLeftWidth || "0") || 0;
  const borderRight = Number.parseFloat(style.borderRightWidth || "0") || 0;
  const width = frame.getBoundingClientRect().width;
  return Math.max(
    0,
    width - frame.clientWidth - borderLeft - borderRight
  );
}

export function syncPreviewScrollbarWidth(frame: HTMLElement) {
  const width = previewScrollbarWidth(frame);
  frame.style.setProperty(
    "--preview-scrollbar-width",
    `${Math.round(width * 10) / 10}px`
  );
}

export function captureViewportAnchor(
  frame: HTMLElement
): PreviewViewportAnchor {
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  return {
    xRatio:
      maxLeft > 0
        ? Math.min(1, Math.max(0, frame.scrollLeft / maxLeft))
        : 0,
    yRatio:
      maxTop > 0
        ? Math.min(1, Math.max(0, frame.scrollTop / maxTop))
        : 0
  };
}

export function restoreViewportAnchor(
  frame: HTMLElement,
  anchor: PreviewViewportAnchor
) {
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  frame.scrollLeft = Math.min(
    maxLeft,
    Math.max(0, anchor.xRatio * maxLeft)
  );
  frame.scrollTop = Math.min(maxTop, Math.max(0, anchor.yRatio * maxTop));
}

export function captureManualViewportAnchor(
  frame: HTMLElement
): ManualViewportAnchor {
  return {
    xCenterRatio:
      frame.scrollWidth > 0
        ? Math.min(
            1,
            Math.max(
              0,
              (frame.scrollLeft + frame.clientWidth / 2) / frame.scrollWidth
            )
          )
        : 0.5,
    yCenterRatio:
      frame.scrollHeight > 0
        ? Math.min(
            1,
            Math.max(
              0,
              (frame.scrollTop + frame.clientHeight / 2) / frame.scrollHeight
            )
          )
        : 0.5
  };
}

export function restoreManualViewportAnchor(
  frame: HTMLElement,
  anchor: ManualViewportAnchor
) {
  const targetCenterX = anchor.xCenterRatio * frame.scrollWidth;
  const targetCenterY = anchor.yCenterRatio * frame.scrollHeight;
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  frame.scrollLeft = Math.min(
    maxLeft,
    Math.max(0, targetCenterX - frame.clientWidth / 2)
  );
  frame.scrollTop = Math.min(
    maxTop,
    Math.max(0, targetCenterY - frame.clientHeight / 2)
  );
}

export function previewPageScrollTarget(
  frame: HTMLElement,
  page: HTMLElement
) {
  const frameRect = frame.getBoundingClientRect();
  const pageRect = page.getBoundingClientRect();
  const pageTop =
    frame.scrollTop + pageRect.top - frameRect.top - frame.clientTop;
  const centerOffset = Math.max(
    0,
    (frame.clientHeight - pageRect.height) / 2
  );
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  return Math.min(maxTop, Math.max(0, pageTop - centerOffset));
}

export function collectRenderedPages(frame: HTMLElement): HTMLElement[] {
  const wrapperPages = Array.from(
    frame.querySelectorAll(".pdf-pages .typst-page")
  ) as HTMLElement[];
  if (wrapperPages.length > 0) return wrapperPages;
  return Array.from(
    frame.querySelectorAll(".pdf-pages canvas")
  ) as HTMLElement[];
}

export function measurePageIndicator(
  frame: HTMLElement,
  preferredPageIndex: number | null
) {
  const pages = collectRenderedPages(frame);
  if (pages.length === 0) {
    return { pageCurrent: 0, pageTotal: 0 };
  }
  const distances = pages.map((page) =>
    // Compare against the same clamped scroll destination used by page
    // jumps. This remains meaningful when several landscape slides fit in
    // the viewport and their visual centers cannot reach the frame center.
    Math.abs(previewPageScrollTarget(frame, page) - frame.scrollTop)
  );
  const bestDistance = Math.min(...distances);
  let bestIndex = distances.findIndex((distance) => distance === bestDistance);
  if (
    preferredPageIndex !== null &&
    preferredPageIndex >= 0 &&
    preferredPageIndex < distances.length &&
    Math.abs(distances[preferredPageIndex] - bestDistance) < 0.5
  ) {
    bestIndex = preferredPageIndex;
  }
  return { pageCurrent: bestIndex + 1, pageTotal: pages.length };
}
