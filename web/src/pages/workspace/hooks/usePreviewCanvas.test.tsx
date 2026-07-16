// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPdfBytesToCanvas } from "@/lib/pdf";
import { renderTypstVectorToCanvas } from "@/lib/typst";
import { usePreviewCanvas } from "@/pages/workspace/hooks/usePreviewCanvas";

vi.mock("@/lib/pdf", () => ({
  renderPdfBytesToCanvas: vi.fn(),
}));

vi.mock("@/lib/typst", () => ({
  renderTypstVectorToCanvas: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
}

function createFrame() {
  const frame = document.createElement("div");
  for (const [name, value] of Object.entries({
    clientHeight: 600,
    clientWidth: 800,
    scrollHeight: 600,
    scrollWidth: 800,
  })) {
    Object.defineProperty(frame, name, { configurable: true, value });
  }
  frame.getBoundingClientRect = vi.fn(() => ({
    bottom: 600,
    height: 600,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  return frame;
}

function appendRenderedPage(frame: HTMLElement) {
  const pages = document.createElement("div");
  pages.className = "pdf-pages";
  const page = document.createElement("div");
  page.className = "typst-page";
  page.dataset.baseHeight = "100";
  page.dataset.baseWidth = "100";
  page.dataset.typstPageOffset = "0";
  page.getBoundingClientRect = vi.fn(() => ({
    bottom: 100,
    height: 100,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  pages.appendChild(page);
  frame.replaceChildren(pages);
  return page;
}

function previewClickEvent(
  frame: HTMLDivElement,
  page: Element | null,
): ReactMouseEvent<HTMLDivElement> {
  return {
    button: 0,
    clientX: 10,
    clientY: 10,
    currentTarget: frame,
    target: page,
  } as unknown as ReactMouseEvent<HTMLDivElement>;
}

function renderPreviewHook(onTypstPreviewClick = vi.fn()) {
  const onRenderError = vi.fn();
  const setPreviewZoom = vi.fn();
  const initialProps: {
    mappingRevision: number | null;
    show: boolean;
    vectorData: Uint8Array | null;
  } = {
    mappingRevision: null,
    show: false,
    vectorData: null,
  };
  const rendered = renderHook(
    ({
      mappingRevision,
      show,
      vectorData,
    }: {
      mappingRevision: number | null;
      show: boolean;
      vectorData: Uint8Array | null;
    }) =>
      usePreviewCanvas({
        showPreviewPanel: show,
        previewArtifactKind: "typst-vector",
        vectorData,
        pdfData: null,
        typstMappingRevision: mappingRevision,
        previewPixelPerPt: 3,
        previewFitMode: "manual",
        previewZoom: 1,
        setPreviewZoom,
        layoutKey: "layout",
        onRenderError,
        renderErrorFallback: "render failed",
        onTypstPreviewClick,
      }),
    {
      initialProps,
    },
  );
  const frame = createFrame();
  act(() => {
    rendered.result.current.canvasPreviewRef.current = frame;
  });
  return { ...rendered, frame, onRenderError, onTypstPreviewClick };
}

beforeEach(() => {
  ResizeObserverStub.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.mocked(renderPdfBytesToCanvas).mockReset();
  vi.mocked(renderTypstVectorToCanvas).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePreviewCanvas", () => {
  it("does not publish a failed render after a newer artifact settles", async () => {
    const stale = deferred();
    const current = deferred();
    vi.mocked(renderTypstVectorToCanvas)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(async (frame) => {
        await current.promise;
        appendRenderedPage(frame);
      });
    const { frame, result, rerender } = renderPreviewHook();

    rerender({
      mappingRevision: 1,
      show: true,
      vectorData: new Uint8Array([1]),
    });
    await waitFor(() =>
      expect(renderTypstVectorToCanvas).toHaveBeenCalledTimes(1),
    );
    rerender({
      mappingRevision: 2,
      show: true,
      vectorData: new Uint8Array([2]),
    });
    await waitFor(() =>
      expect(renderTypstVectorToCanvas).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      current.resolve();
      await current.promise;
    });
    await waitFor(() => {
      expect(result.current.previewRendering).toBe(false);
      expect(result.current.renderedTypstMappingRevision).toBe(2);
      expect(result.current.previewPageTotal).toBe(1);
    });
    const settledTick = result.current.previewRenderTick;

    await act(async () => {
      stale.reject(new Error("obsolete render"));
      await stale.promise.catch(() => undefined);
    });
    expect(result.current.previewRenderTick).toBe(settledTick);
    expect(result.current.renderedTypstMappingRevision).toBe(2);
    expect(frame.querySelectorAll(".typst-page")).toHaveLength(1);
  });

  it("clears source mapping while replacing the preview and releases observers", async () => {
    const replacement = deferred();
    vi.mocked(renderTypstVectorToCanvas)
      .mockImplementationOnce(async (frame) => {
        appendRenderedPage(frame);
      })
      .mockImplementationOnce(() => replacement.promise);
    const { frame, onTypstPreviewClick, result, rerender, unmount } =
      renderPreviewHook();

    rerender({
      mappingRevision: 7,
      show: true,
      vectorData: new Uint8Array([7]),
    });
    await waitFor(() =>
      expect(result.current.renderedTypstMappingRevision).toBe(7),
    );
    const page = frame.querySelector(".typst-page");
    expect(page).not.toBeNull();
    act(() => {
      result.current.handlePreviewClick(previewClickEvent(frame, page));
    });
    expect(onTypstPreviewClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageOffset: 0 }),
      7,
    );

    rerender({
      mappingRevision: 8,
      show: true,
      vectorData: new Uint8Array([8]),
    });
    await waitFor(() => expect(result.current.previewRendering).toBe(true));
    act(() => {
      result.current.handlePreviewClick(previewClickEvent(frame, page));
    });
    expect(onTypstPreviewClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageOffset: 0 }),
      null,
    );

    const observer = ResizeObserverStub.instances.at(-1);
    expect(observer).toBeDefined();
    unmount();
    expect(observer?.disconnect).toHaveBeenCalledOnce();
    await act(async () => {
      replacement.resolve();
      await replacement.promise;
    });
  });

  it("removes rendered pages when the current session has no artifact", async () => {
    vi.mocked(renderTypstVectorToCanvas).mockImplementationOnce(async (frame) => {
      appendRenderedPage(frame);
    });
    const { frame, result, rerender } = renderPreviewHook();

    rerender({
      mappingRevision: 3,
      show: true,
      vectorData: new Uint8Array([3]),
    });
    await waitFor(() => expect(result.current.previewPageTotal).toBe(1));

    rerender({ mappingRevision: null, show: true, vectorData: null });
    await waitFor(() => expect(result.current.previewPageTotal).toBe(0));
    expect(frame.querySelectorAll(".typst-page")).toHaveLength(0);
    expect(result.current.renderedTypstMappingRevision).toBeNull();
  });
});
