// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacePreviewPreferences } from "@/pages/workspace/hooks/useWorkspacePreviewPreferences";

const PROJECT_ID = "project-a";
const SETTINGS_KEY = `workspace.preview.settings.${PROJECT_ID}`;

describe("useWorkspacePreviewPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hydrates project preferences before the first committed render", () => {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        zoom: 1.8,
        fitMode: "manual",
        renderer: "pdf",
        rendererVersion: 2,
        anchor: { xRatio: 0.25, yRatio: 0.75 }
      })
    );

    const { result } = renderHook(() =>
      useWorkspacePreviewPreferences(PROJECT_ID)
    );

    expect(result.current).toMatchObject({
      previewZoom: 1.8,
      previewFitMode: "manual",
      typstPreviewRenderer: "pdf",
      previewInitialAnchor: { xRatio: 0.25, yRatio: 0.75 }
    });
  });

  it("preserves fitted zoom below the manual floor while clamping manual zoom", () => {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        zoom: 0.03,
        fitMode: "page",
        renderer: "canvas",
        rendererVersion: 2,
        anchor: { xRatio: 0, yRatio: 0 }
      })
    );

    const fitted = renderHook(() =>
      useWorkspacePreviewPreferences(PROJECT_ID)
    );
    expect(fitted.result.current.previewZoom).toBe(0.03);
    fitted.unmount();

    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        zoom: 0.03,
        fitMode: "manual",
        renderer: "canvas",
        rendererVersion: 2,
        anchor: { xRatio: 0, yRatio: 0 }
      })
    );
    const manual = renderHook(() =>
      useWorkspacePreviewPreferences(PROJECT_ID)
    );
    expect(manual.result.current.previewZoom).toBe(0.05);
  });

  it("coalesces rapid viewport updates into one storage write", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() =>
      useWorkspacePreviewPreferences(PROJECT_ID)
    );
    setItem.mockClear();

    act(() => {
      result.current.handleViewportAnchorChange({ xRatio: 0.1, yRatio: 0.2 });
      result.current.handleViewportAnchorChange({ xRatio: 0.3, yRatio: 0.4 });
      result.current.handleViewportAnchorChange({ xRatio: 0.5, yRatio: 0.6 });
      vi.advanceTimersByTime(249);
    });
    expect(setItem).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({
      anchor: { xRatio: 0.5, yRatio: 0.6 }
    });
  });

  it("persists a preference change with the latest anchor", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useWorkspacePreviewPreferences(PROJECT_ID)
    );

    act(() => {
      result.current.handleViewportAnchorChange({ xRatio: 0.4, yRatio: 0.7 });
      result.current.setPreviewFitMode("width");
    });

    expect(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}")).toMatchObject({
      fitMode: "width",
      anchor: { xRatio: 0.4, yRatio: 0.7 }
    });
  });
});
