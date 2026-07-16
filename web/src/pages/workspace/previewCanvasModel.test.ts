// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  captureViewportAnchor,
  initialPreviewCanvasState,
  measurePageIndicator,
  previewCanvasReducer,
  restoreViewportAnchor
} from "@/pages/workspace/previewCanvasModel";

function setDimensions(
  element: HTMLElement,
  dimensions: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
  }
) {
  for (const [name, value] of Object.entries(dimensions)) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
}

function appendPages(frame: HTMLElement, pageTops: number[]) {
  const pages = document.createElement("div");
  pages.className = "pdf-pages";
  for (const top of pageTops) {
    const page = document.createElement("div");
    page.className = "typst-page";
    page.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: top,
      top,
      right: 100,
      bottom: top + 100,
      left: 0,
      width: 100,
      height: 100,
      toJSON: () => ({})
    }));
    pages.appendChild(page);
  }
  frame.appendChild(pages);
}

describe("previewCanvasReducer", () => {
  it("keeps render, page, and mapping state in one lifecycle", () => {
    const ready = previewCanvasReducer(initialPreviewCanvasState, {
      type: "render.settled",
      pageCurrent: 2,
      pageTotal: 3,
      mappingRevision: 11
    });
    expect(ready).toMatchObject({
      renderRevision: 1,
      renderStatus: "ready",
      pageCurrent: 2,
      pageTotal: 3,
      renderedMappingRevision: 11
    });

    const rendering = previewCanvasReducer(ready, { type: "render.started" });
    expect(rendering).toMatchObject({
      renderRevision: 1,
      renderStatus: "rendering",
      pageCurrent: 2,
      pageTotal: 3,
      renderedMappingRevision: null
    });

    const failed = previewCanvasReducer(rendering, {
      type: "render.failed",
      pageCurrent: 2,
      pageTotal: 3
    });
    expect(failed).toMatchObject({
      renderRevision: 1,
      renderStatus: "failed",
      pageCurrent: 2,
      pageTotal: 3,
      renderedMappingRevision: null
    });
  });

  it("does not publish unchanged page measurements", () => {
    const state = {
      ...initialPreviewCanvasState,
      pageCurrent: 1,
      pageTotal: 3
    };
    expect(
      previewCanvasReducer(state, {
        type: "pages.measured",
        pageCurrent: 1,
        pageTotal: 3
      })
    ).toBe(state);
  });
});

describe("preview canvas viewport", () => {
  it("selects the page nearest the current scroll target", () => {
    const frame = document.createElement("div");
    setDimensions(frame, {
      clientWidth: 100,
      clientHeight: 100,
      scrollWidth: 100,
      scrollHeight: 300
    });
    frame.scrollTop = 100;
    frame.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 100,
      left: 0,
      width: 100,
      height: 100,
      toJSON: () => ({})
    }));
    appendPages(frame, [-100, 0, 100]);

    expect(measurePageIndicator(frame, null)).toEqual({
      pageCurrent: 2,
      pageTotal: 3
    });
  });

  it("honors an explicit page when several slides share a clamped target", () => {
    const frame = document.createElement("div");
    setDimensions(frame, {
      clientWidth: 100,
      clientHeight: 300,
      scrollWidth: 100,
      scrollHeight: 300
    });
    frame.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 300,
      left: 0,
      width: 100,
      height: 300,
      toJSON: () => ({})
    }));
    appendPages(frame, [0, 100, 200]);

    expect(measurePageIndicator(frame, 2)).toEqual({
      pageCurrent: 3,
      pageTotal: 3
    });
  });

  it("captures and restores proportional scroll anchors", () => {
    const frame = document.createElement("div");
    setDimensions(frame, {
      clientWidth: 100,
      clientHeight: 100,
      scrollWidth: 500,
      scrollHeight: 300
    });
    frame.scrollLeft = 200;
    frame.scrollTop = 100;
    expect(captureViewportAnchor(frame)).toEqual({
      xRatio: 0.5,
      yRatio: 0.5
    });

    restoreViewportAnchor(frame, { xRatio: 0.25, yRatio: 0.75 });
    expect(frame.scrollLeft).toBe(100);
    expect(frame.scrollTop).toBe(150);
  });
});
