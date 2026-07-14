import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction
} from "react";
import type { PreviewFitMode } from "@/pages/workspace/types";
import {
  clampNumber,
  PREVIEW_FIT_MIN_ZOOM,
  PREVIEW_MANUAL_MIN_ZOOM,
  PREVIEW_MAX_ZOOM
} from "@/pages/workspace/utils";

const PREVIEW_RENDERER_SETTINGS_VERSION = 2;
const VIEWPORT_ANCHOR_PERSIST_DELAY_MS = 250;

type PreviewRenderer = "pdf" | "canvas";
type PreviewAnchor = { xRatio: number; yRatio: number };

type PreviewPreferences = {
  zoom: number;
  fitMode: PreviewFitMode;
  renderer: PreviewRenderer;
};

type StoredPreviewPreferences = PreviewPreferences & {
  anchor: PreviewAnchor;
};

const DEFAULT_PREVIEW_PREFERENCES: StoredPreviewPreferences = {
  zoom: 1,
  fitMode: "page",
  renderer: "canvas",
  anchor: { xRatio: 0, yRatio: 0 }
};

function settingsKey(projectId: string) {
  return `workspace.preview.settings.${projectId}`;
}

function resolveUpdate<T>(update: SetStateAction<T>, current: T) {
  return typeof update === "function"
    ? (update as (value: T) => T)(current)
    : update;
}

function readPreviewPreferences(projectId: string): StoredPreviewPreferences {
  if (typeof window === "undefined" || !projectId) {
    return DEFAULT_PREVIEW_PREFERENCES;
  }
  const raw = window.localStorage.getItem(settingsKey(projectId));
  if (!raw) return DEFAULT_PREVIEW_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as {
      fitMode?: PreviewFitMode;
      zoom?: number;
      renderer?: PreviewRenderer;
      rendererVersion?: number;
      anchor?: { xRatio?: number; yRatio?: number };
    };
    const fitMode =
      parsed.fitMode === "manual" ||
      parsed.fitMode === "page" ||
      parsed.fitMode === "width"
        ? parsed.fitMode
        : DEFAULT_PREVIEW_PREFERENCES.fitMode;
    return {
      fitMode,
      zoom:
        typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom)
          ? clampNumber(
              parsed.zoom,
              fitMode === "manual"
                ? PREVIEW_MANUAL_MIN_ZOOM
                : PREVIEW_FIT_MIN_ZOOM,
              PREVIEW_MAX_ZOOM
            )
          : DEFAULT_PREVIEW_PREFERENCES.zoom,
      renderer:
        parsed.rendererVersion === PREVIEW_RENDERER_SETTINGS_VERSION &&
        (parsed.renderer === "canvas" || parsed.renderer === "pdf")
          ? parsed.renderer
          : DEFAULT_PREVIEW_PREFERENCES.renderer,
      anchor: {
        xRatio:
          typeof parsed.anchor?.xRatio === "number" &&
          Number.isFinite(parsed.anchor.xRatio)
            ? clampNumber(parsed.anchor.xRatio, 0, 1)
            : 0,
        yRatio:
          typeof parsed.anchor?.yRatio === "number" &&
          Number.isFinite(parsed.anchor.yRatio)
            ? clampNumber(parsed.anchor.yRatio, 0, 1)
            : 0
      }
    };
  } catch {
    return DEFAULT_PREVIEW_PREFERENCES;
  }
}

function persistPreviewPreferences(
  projectId: string,
  preferences: PreviewPreferences,
  anchor: PreviewAnchor
) {
  if (!projectId) return;
  window.localStorage.setItem(
    settingsKey(projectId),
    JSON.stringify({
      ...preferences,
      rendererVersion: PREVIEW_RENDERER_SETTINGS_VERSION,
      anchor
    })
  );
}

export function useWorkspacePreviewPreferences(projectId: string) {
  const initialRef = useRef<StoredPreviewPreferences | null>(null);
  if (initialRef.current === null) {
    initialRef.current = readPreviewPreferences(projectId);
  }
  const initial = initialRef.current;
  const [preferences, setPreferences] = useState<PreviewPreferences>({
    zoom: initial.zoom,
    fitMode: initial.fitMode,
    renderer: initial.renderer
  });
  const anchorRef = useRef<PreviewAnchor>(initial.anchor);
  const latestPreferencesRef = useRef(preferences);
  const anchorPersistTimerRef = useRef<number | null>(null);

  useEffect(() => {
    latestPreferencesRef.current = preferences;
    if (anchorPersistTimerRef.current !== null) {
      window.clearTimeout(anchorPersistTimerRef.current);
      anchorPersistTimerRef.current = null;
    }
    persistPreviewPreferences(projectId, preferences, anchorRef.current);
  }, [preferences, projectId]);

  useEffect(
    () => () => {
      if (anchorPersistTimerRef.current === null) return;
      window.clearTimeout(anchorPersistTimerRef.current);
      anchorPersistTimerRef.current = null;
      persistPreviewPreferences(
        projectId,
        latestPreferencesRef.current,
        anchorRef.current
      );
    },
    [projectId]
  );

  const setPreviewZoom = useCallback((update: SetStateAction<number>) => {
    setPreferences((current) => ({
      ...current,
      zoom: resolveUpdate(update, current.zoom)
    }));
  }, []);

  const setPreviewFitMode = useCallback(
    (update: SetStateAction<PreviewFitMode>) => {
      setPreferences((current) => ({
        ...current,
        fitMode: resolveUpdate(update, current.fitMode)
      }));
    },
    []
  );

  const setTypstPreviewRenderer = useCallback(
    (update: SetStateAction<PreviewRenderer>) => {
      setPreferences((current) => ({
        ...current,
        renderer: resolveUpdate(update, current.renderer)
      }));
    },
    []
  );

  const handleViewportAnchorChange = useCallback(
    (anchor: PreviewAnchor) => {
      anchorRef.current = anchor;
      if (anchorPersistTimerRef.current !== null) {
        window.clearTimeout(anchorPersistTimerRef.current);
      }
      anchorPersistTimerRef.current = window.setTimeout(() => {
        anchorPersistTimerRef.current = null;
        persistPreviewPreferences(
          projectId,
          latestPreferencesRef.current,
          anchorRef.current
        );
      }, VIEWPORT_ANCHOR_PERSIST_DELAY_MS);
    },
    [projectId]
  );

  return {
    previewZoom: preferences.zoom,
    setPreviewZoom,
    previewFitMode: preferences.fitMode,
    setPreviewFitMode,
    typstPreviewRenderer: preferences.renderer,
    setTypstPreviewRenderer,
    previewInitialAnchor: initial.anchor,
    handleViewportAnchorChange
  };
}
