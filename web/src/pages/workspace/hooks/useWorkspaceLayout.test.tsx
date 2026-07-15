// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceLayout } from "@/pages/workspace/hooks/useWorkspaceLayout";
import { WORKSPACE_LAYOUT_KEY } from "@/pages/workspace/utils";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width
  });
}

describe("useWorkspaceLayout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportWidth(1440);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses stored dimensions on the first committed render", () => {
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_KEY,
      JSON.stringify({
        filesWidth: 360,
        settingsWidth: 380,
        revisionsWidth: 400,
        editorRatio: 0.42
      })
    );

    const { result } = renderHook(() => useWorkspaceLayout());

    expect(result.current).toMatchObject({
      filesPanelWidth: 360,
      auxiliaryPanelWidth: 380,
      editorRatio: 0.42
    });
  });

  it("keeps core and optional auxiliary panels mutually exclusive", () => {
    const { result } = renderHook(() => useWorkspaceLayout());

    act(() => result.current.togglePanel("settings"));
    expect(result.current).toMatchObject({
      effectiveShowSettingsPanel: true,
      effectiveShowRevisionsPanel: false,
      effectiveAuxiliaryPanel: "settings"
    });

    act(() => result.current.togglePanel("feature:ai_assistant"));
    expect(result.current).toMatchObject({
      effectiveShowSettingsPanel: false,
      effectiveShowRevisionsPanel: false,
      effectiveAuxiliaryPanel: "feature:ai_assistant"
    });

    act(() => result.current.togglePanel("feature:ai_assistant"));
    expect(result.current.effectiveAuxiliaryPanel).toBeNull();
  });

  it("updates responsive behavior only from viewport breakpoint snapshots", () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    expect(result.current).toMatchObject({
      collapsePanelToggles: false,
      showAccountControlsInViewMenu: false,
      singlePanelMode: false
    });

    act(() => {
      setViewportWidth(1200);
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toMatchObject({
      collapsePanelToggles: true,
      showAccountControlsInViewMenu: false,
      singlePanelMode: false
    });

    act(() => {
      setViewportWidth(900);
      window.dispatchEvent(new Event("resize"));
    });
    act(() => {
      result.current.togglePanel("preview");
    });
    expect(result.current).toMatchObject({
      showAccountControlsInViewMenu: true,
      singlePanelMode: true,
      compactPanelView: "preview",
      effectiveShowEditorPanel: false,
      effectiveShowPreviewPanel: true
    });
  });

  it("coalesces rapid dimension changes into one storage write", async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useWorkspaceLayout());

    act(() => {
      result.current.resizeFilesPanel(20);
      result.current.resizeFilesPanel(20);
      result.current.resizeFilesPanel(20);
    });
    expect(setItem).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({
      filesWidth: 360
    });
  });
});
