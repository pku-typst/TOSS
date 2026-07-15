import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent
} from "react";
import type {
  WorkspaceAuxiliaryPanel,
  WorkspaceLayoutPrefs,
  WorkspacePanelView
} from "@/pages/workspace/types";
import {
  clampNumber,
  MAX_EDITOR_RATIO,
  MAX_SIDE_PANEL_WIDTH,
  MIN_EDITOR_RATIO,
  MIN_SIDE_PANEL_WIDTH,
  readWorkspaceLayoutPrefs,
  WORKSPACE_LAYOUT_KEY
} from "@/pages/workspace/utils";

const COLLAPSED_PANEL_CONTROLS_MAX_WIDTH = 1320;
const ACCOUNT_CONTROLS_IN_MENU_MAX_WIDTH = 1180;
const SINGLE_PANEL_MAX_WIDTH = 980;
const LAYOUT_PERSIST_DELAY_MS = 250;

type PrimarySidePanel = "files" | "preview";
type SidePanel = PrimarySidePanel | WorkspaceAuxiliaryPanel;
type ViewportBand = 0 | 1 | 2 | 3;

function viewportBandForWidth(width: number): ViewportBand {
  if (width <= SINGLE_PANEL_MAX_WIDTH) return 3;
  if (width <= ACCOUNT_CONTROLS_IN_MENU_MAX_WIDTH) return 2;
  if (width <= COLLAPSED_PANEL_CONTROLS_MAX_WIDTH) return 1;
  return 0;
}

function currentViewportBand(): ViewportBand {
  if (typeof window === "undefined") return 0;
  return viewportBandForWidth(window.innerWidth);
}

function subscribeViewport(onStoreChange: () => void) {
  window.addEventListener("resize", onStoreChange);
  return () => window.removeEventListener("resize", onStoreChange);
}

export function useWorkspaceLayout() {
  const [preferences, setPreferences] = useState<WorkspaceLayoutPrefs>(
    readWorkspaceLayoutPrefs
  );
  const [visiblePanels, setVisiblePanels] = useState<Record<PrimarySidePanel, boolean>>({
    files: true,
    preview: true
  });
  const [auxiliaryPanel, setAuxiliaryPanel] =
    useState<WorkspaceAuxiliaryPanel | null>(null);
  const [compactPanelView, selectCompactPanel] =
    useState<WorkspacePanelView>("editor");
  const viewportBand = useSyncExternalStore(
    subscribeViewport,
    currentViewportBand,
    () => 0
  );
  const latestPreferencesRef = useRef(preferences);
  const persistTimerRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const flushPreferences = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_KEY,
      JSON.stringify(latestPreferencesRef.current)
    );
  }, []);

  useEffect(() => {
    latestPreferencesRef.current = preferences;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(
      flushPreferences,
      LAYOUT_PERSIST_DELAY_MS
    );
  }, [flushPreferences, preferences]);

  useEffect(
    () => () => {
      flushPreferences();
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    },
    [flushPreferences]
  );

  const resizeFilesPanel = useCallback((deltaX: number) => {
    setPreferences((current) => ({
      ...current,
      filesWidth: clampNumber(
        current.filesWidth + deltaX,
        MIN_SIDE_PANEL_WIDTH,
        MAX_SIDE_PANEL_WIDTH
      )
    }));
  }, []);
  const resizeAuxiliaryPanel = useCallback((deltaX: number) => {
    setPreferences((current) => ({
      ...current,
      auxiliaryWidth: clampNumber(
        current.auxiliaryWidth - deltaX,
        MIN_SIDE_PANEL_WIDTH,
        MAX_SIDE_PANEL_WIDTH
      )
    }));
  }, []);
  const resizeEditorSplit = useCallback((deltaX: number, totalWidth: number) => {
    setPreferences((current) => ({
      ...current,
      editorRatio: clampNumber(
        current.editorRatio + deltaX / Math.max(totalWidth, 1),
        MIN_EDITOR_RATIO,
        MAX_EDITOR_RATIO
      )
    }));
  }, []);

  const singlePanelMode = viewportBand >= 3;
  const collapsePanelToggles = viewportBand >= 1;
  const showAccountControlsInViewMenu = viewportBand >= 2;
  const effectiveShowFilesPanel = singlePanelMode
    ? compactPanelView === "files"
    : visiblePanels.files;
  const effectiveShowPreviewPanel = singlePanelMode
    ? compactPanelView === "preview"
    : visiblePanels.preview;
  const effectiveAuxiliaryPanel = singlePanelMode
    ? compactPanelView === "settings" ||
      compactPanelView === "revisions" ||
      compactPanelView.startsWith("feature:")
      ? compactPanelView
      : null
    : auxiliaryPanel;
  const effectiveShowSettingsPanel = effectiveAuxiliaryPanel === "settings";
  const effectiveShowRevisionsPanel = effectiveAuxiliaryPanel === "revisions";
  const effectiveShowEditorPanel =
    !singlePanelMode || compactPanelView === "editor";

  const togglePanel = useCallback(
    (panel: SidePanel) => {
      if (singlePanelMode) {
        selectCompactPanel(panel);
        return;
      }
      if (panel !== "files" && panel !== "preview") {
        setAuxiliaryPanel((current) => (current === panel ? null : panel));
        return;
      }
      setVisiblePanels((current) => ({
        ...current,
        [panel]: !current[panel]
      }));
    },
    [singlePanelMode]
  );

  const beginHorizontalResize = useCallback(
    (onDelta: (deltaX: number) => void) =>
      (event: ReactMouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        resizeCleanupRef.current?.();
        let lastX = event.clientX;
        const onMove = (moveEvent: MouseEvent) => {
          const deltaX = moveEvent.clientX - lastX;
          lastX = moveEvent.clientX;
          if (deltaX !== 0) onDelta(deltaX);
        };
        const finish = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", finish);
          resizeCleanupRef.current = null;
        };
        resizeCleanupRef.current = finish;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", finish);
      },
    []
  );

  return {
    filesPanelWidth: preferences.filesWidth,
    resizeFilesPanel,
    auxiliaryPanelWidth: preferences.auxiliaryWidth,
    resizeAuxiliaryPanel,
    editorRatio: preferences.editorRatio,
    resizeEditorSplit,
    collapsePanelToggles,
    singlePanelMode,
    showAccountControlsInViewMenu,
    compactPanelView,
    selectCompactPanel,
    effectiveShowFilesPanel,
    effectiveShowPreviewPanel,
    effectiveShowSettingsPanel,
    effectiveShowRevisionsPanel,
    effectiveAuxiliaryPanel,
    effectiveShowEditorPanel,
    togglePanel,
    beginHorizontalResize
  };
}
