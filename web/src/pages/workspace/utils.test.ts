// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyPreviewZoom,
  deriveFitZoom,
  nextManualPreviewZoom,
  pixelPerPtForZoom,
  PREVIEW_MANUAL_MIN_ZOOM
} from "@/pages/workspace/utils";

afterEach(() => {
  document.body.replaceChildren();
});

function narrowSlidePreview() {
  const frame = document.createElement("div");
  const pages = document.createElement("div");
  const slide = document.createElement("div");
  pages.className = "pdf-pages";
  pages.style.padding = "12px";
  slide.className = "typst-page";
  slide.dataset.baseWidth = "2880";
  slide.dataset.baseHeight = "1620";
  pages.append(slide);
  frame.append(pages);
  document.body.append(frame);
  Object.defineProperties(frame, {
    clientWidth: { configurable: true, value: 280 },
    clientHeight: { configurable: true, value: 200 }
  });
  return { frame, pages, slide };
}

describe("preview zoom policy", () => {
  it("fits a wide NV slide below the manual zoom floor without horizontal overflow", () => {
    const { frame, pages, slide } = narrowSlidePreview();

    const zoom = deriveFitZoom(frame, pages, "page");
    applyPreviewZoom(frame, zoom);

    expect(zoom).toBeLessThan(0.2);
    expect(Number.parseFloat(slide.style.width)).toBeLessThanOrEqual(254);
    expect(Number.parseFloat(pages.style.width)).toBeLessThanOrEqual(280);
  });

  it("keeps manual button zoom proportional and bounded", () => {
    expect(nextManualPreviewZoom(0.1, "in")).toBeCloseTo(0.12);
    expect(nextManualPreviewZoom(0.1, "out")).toBeCloseTo(1 / 12);
    expect(nextManualPreviewZoom(0.01, "out")).toBe(
      PREVIEW_MANUAL_MIN_ZOOM
    );
  });

  it("keeps a render-density floor independent from display zoom", () => {
    expect(pixelPerPtForZoom("page", 0.08)).toBe(0.25);
  });
});
