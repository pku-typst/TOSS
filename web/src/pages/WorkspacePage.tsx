import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import "@/pages/workspace/styles.css";
import { createPortal } from "react-dom";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { UiButton } from "@/components/ui";
import { useCompilationEnvironment } from "@/compilation/compilationEnvironment";
import {
  AiAssistantPanel,
  AI_ASSISTANT_PANEL_ID,
  AssistantEditReviewCoordinator,
  AssistantEditReviewPane,
  aiAssistantWorkspacePanel,
  aiAssistantSettingsSection,
  compileWorkspaceCandidate,
  compileWorldWithCandidateDocument,
  createAiWorkspacePort,
  type AiWorkspaceCandidateCompileResult,
  type AiWorkspaceCompilationSnapshot,
  type AiWorkspaceContextSnapshot,
  type AiWorkspaceToolSource
} from "@/features/ai";
import {
  type AuthUser,
  type AnonymousMode,
  type OrganizationMembership,
  type Project,
  type ProjectPermission,
  type AuthConfig
} from "@/lib/api";
import { prewarmTypstClientSide } from "@/lib/typst";
import { deploymentEnablesFrontendFeature } from "@/lib/deploymentCapabilities";
import { FileTreePanel } from "@/pages/workspace/components/FileTreePanel";
import { EditorPanel } from "@/pages/workspace/components/EditorPanel";
import { PreviewPanel } from "@/pages/workspace/components/PreviewPanel";
import { RevisionsPanel } from "@/pages/workspace/components/RevisionsPanel";
import { WorkspaceSettingsContainer } from "@/pages/workspace/components/WorkspaceSettingsContainer";
import { WorkspaceAccessBanner } from "@/pages/workspace/components/WorkspaceAccessBanner";
import { WorkspaceOverlays } from "@/pages/workspace/components/WorkspaceOverlays";
import { WorkspaceToolbar } from "@/pages/workspace/components/WorkspaceToolbar";
import { StatusPage } from "@/pages/StatusPage";
import { usePreviewCanvas } from "@/pages/workspace/hooks/usePreviewCanvas";
import { useProjectRealtime } from "@/pages/workspace/hooks/useProjectRealtime";
import { useProjectTree } from "@/pages/workspace/hooks/useProjectTree";
import { useRealtimeDoc } from "@/pages/workspace/hooks/useRealtimeDoc";
import { useWorkspaceAssetHydration } from "@/pages/workspace/hooks/useWorkspaceAssetHydration";
import { useWorkspaceCompilation } from "@/pages/workspace/hooks/useWorkspaceCompilation";
import { useWorkspaceCompileInputs } from "@/pages/workspace/hooks/useWorkspaceCompileInputs";
import { useWorkspaceFileActions } from "@/pages/workspace/hooks/useWorkspaceFileActions";
import { useWorkspaceSession } from "@/pages/workspace/hooks/useWorkspaceSession";
import { useWorkspaceProjectActions } from "@/pages/workspace/hooks/useWorkspaceProjectActions";
import { useWorkspacePreviewPreferences } from "@/pages/workspace/hooks/useWorkspacePreviewPreferences";
import { useWorkspaceRemoteSync } from "@/pages/workspace/hooks/useWorkspaceRemoteSync";
import { useWorkspaceRevisions } from "@/pages/workspace/hooks/useWorkspaceRevisions";
import { useWorkspaceLayout } from "@/pages/workspace/hooks/useWorkspaceLayout";
import { useWorkspaceGuestSession } from "@/pages/workspace/hooks/useWorkspaceGuestSession";
import { useWorkspacePreviewThumbnail } from "@/pages/workspace/hooks/useWorkspacePreviewThumbnail";
import { useWorkspaceSourceNavigation } from "@/pages/workspace/hooks/useWorkspaceSourceNavigation";
import { useBackgroundLatexBuild } from "@/pages/processing/useBackgroundLatexBuild";
import {
  deriveWorkspacePermissions
} from "@/pages/workspace/access";
import {
  clampNumber,
  editorLanguageForPath,
  inferContentType,
  isImageAsset,
  isPdfAsset,
  isTextFile,
  looksLikeUuid,
  nextManualPreviewZoom,
  pixelPerPtForZoom,
  presenceColor,
  PREVIEW_MANUAL_MIN_ZOOM,
  PREVIEW_MAX_ZOOM
} from "@/pages/workspace/utils";
import type { Translator, UiLocale } from "@/lib/i18n";
import type { WorkspaceSettingsSectionId } from "@/pages/workspace/types";
import {
  coreWorkspaceFeatureAvailability,
  type WorkspaceFeatureAvailability,
} from "@/pages/workspace/featureAvailability";

type WorkspacePageProps = {
  projects: Project[];
  organizations: OrganizationMembership[];
  authUser: AuthUser | null;
  authConfig?: AuthConfig | null;
  locale: UiLocale;
  onLocaleChange: (locale: UiLocale) => void;
  refreshProjects: () => Promise<void>;
  t: Translator;
  projectIdOverride?: string;
  shareToken?: string | null;
  sharePermission?: ProjectPermission | null;
  anonymousMode?: AnonymousMode | null;
  shareSaveStatus?: "idle" | "saving" | "saved" | "error";
  shareSaveError?: string | null;
  onSaveSharedProject?: () => Promise<void>;
  onSignInFromWorkspace?: () => Promise<void>;
  onLogoutFromWorkspace?: () => Promise<void>;
  featureAvailability?: WorkspaceFeatureAvailability;
};

export function WorkspacePage(props: WorkspacePageProps) {
  const { projectId: routeProjectId = "" } = useParams();
  const projectId = props.projectIdOverride || routeProjectId;
  const navigate = useNavigate();
  if (!projectId) return <Navigate to="/projects" replace />;
  const project = props.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return (
      <StatusPage
        kind="project"
        title={props.t("status.projectUnavailableTitle")}
        description={props.t("status.projectUnavailableDescription")}
        actionLabel={props.t("status.backProjects")}
        onAction={() => navigate("/projects", { replace: true })}
        secondaryLabel={props.t("nav.help")}
        onSecondaryAction={() => navigate("/help")}
      />
    );
  }
  return (
    <ResolvedWorkspacePage
      key={projectId}
      {...props}
      projectId={projectId}
      project={project}
    />
  );
}

type ResolvedWorkspacePageProps = WorkspacePageProps & {
  projectId: string;
  project: Project;
};

function ResolvedWorkspacePage({
  projects,
  organizations,
  authUser,
  authConfig,
  locale,
  onLocaleChange,
  refreshProjects,
  t,
  projectId,
  project,
  shareToken,
  sharePermission,
  anonymousMode,
  shareSaveStatus = "idle",
  shareSaveError = null,
  onSaveSharedProject,
  onSignInFromWorkspace,
  onLogoutFromWorkspace,
  featureAvailability = coreWorkspaceFeatureAvailability
}: ResolvedWorkspacePageProps) {
  const compilationEnvironment = useCompilationEnvironment();
  const navigate = useNavigate();
  const {
    guestSessionToken,
    shareGuestSession,
    isAnonymousShare,
    effectiveUserId,
    effectiveUserName,
    authModalOpen,
    openAuthModal,
    closeAuthModal,
    guestNameInput,
    setGuestNameInput,
    guestAuthError,
    guestAuthPending,
    beginTemporaryGuestEditing: establishTemporaryGuestSession,
    handleAuthModalSignedIn
  } = useWorkspaceGuestSession({
    projectId,
    authUser,
    shareToken,
    navigate,
    refreshProjects,
    onSignInFromWorkspace,
    t
  });
  const centerSplitRef = useRef<HTMLDivElement | null>(null);
  const [lineWrapEnabled, setLineWrapEnabled] = useState(true);
  const aiAssistantEnabled = deploymentEnablesFrontendFeature(
    authConfig,
    "ai_assistant"
  );

  const {
    filesPanelWidth,
    resizeFilesPanel,
    auxiliaryPanelWidth,
    resizeAuxiliaryPanel,
    editorRatio,
    resizeEditorSplit,
    collapsePanelToggles,
    singlePanelMode,
    showAccountControlsInViewMenu,
    compactPanelView,
    selectCompactPanel,
    effectiveShowFilesPanel,
    effectiveShowPreviewPanel,
    effectiveShowSettingsPanel,
    effectiveShowRevisionsPanel: effectiveShowRevisionPanel,
    effectiveAuxiliaryPanel,
    effectiveShowEditorPanel,
    togglePanel,
    openPanel,
    beginHorizontalResize
  } = useWorkspaceLayout();
  const revisionPanelActive =
    featureAvailability.revisions && effectiveShowRevisionPanel;
  useEffect(() => {
    if (!featureAvailability.revisions && compactPanelView === "revisions") {
      selectCompactPanel("editor");
    }
  }, [compactPanelView, featureAvailability.revisions, selectCompactPanel]);
  const [preferredSettingsSection, setPreferredSettingsSection] =
    useState<WorkspaceSettingsSectionId | null>(null);
  const assistantPanelActive =
    aiAssistantEnabled && effectiveAuxiliaryPanel === AI_ASSISTANT_PANEL_ID;
  const [assistantPanelMounted, setAssistantPanelMounted] = useState(false);
  useEffect(() => {
    if (assistantPanelActive) setAssistantPanelMounted(true);
  }, [assistantPanelActive]);
  const assistantPanelControl = aiAssistantWorkspacePanel(
    aiAssistantEnabled,
    assistantPanelActive,
    t
  );
  const assistantSettingsSection = aiAssistantSettingsSection({
    enabled: aiAssistantEnabled,
    accountId: authUser?.user_id ?? null,
    locale,
    aiAssistantConfig: authConfig?.ai_assistant ?? null,
    t
  });
  const openAssistantSettings = useCallback(() => {
    setPreferredSettingsSection(AI_ASSISTANT_PANEL_ID);
    openPanel("settings");
  }, [openPanel]);
  useEffect(() => {
    if (effectiveShowSettingsPanel && preferredSettingsSection) {
      setPreferredSettingsSection(null);
    }
  }, [effectiveShowSettingsPanel, preferredSettingsSection]);
  const {
    previewZoom,
    setPreviewZoom,
    previewFitMode,
    setPreviewFitMode,
    typstPreviewRenderer,
    setTypstPreviewRenderer,
    previewInitialAnchor,
    handleViewportAnchorChange
  } = useWorkspacePreviewPreferences(projectId);
  const {
    canRequestGuestWrite,
    canWrite,
    canManageProject,
    canViewWriteShareLink
  } = deriveWorkspacePermissions({
    isAnonymousShare,
    sharePermission: sharePermission ?? null,
    anonymousMode,
    project,
    hasGuestSessionToken: !!guestSessionToken,
    hasAuthUser: !!authUser
  });
  const workspaceSession = useWorkspaceSession({
    projectId,
    project,
    effectiveUserId,
    offlineCacheIdentity:
      shareToken || !authUser ? null : authUser.user_id,
    accessSessionKey: JSON.stringify([
      effectiveUserId,
      shareToken ?? null,
      shareGuestSession,
    ]),
    canWrite: !!canWrite,
    cachedOfflineMessage: t("workspace.cachedOffline"),
    loadErrorMessage: t("errors.loadWorkspace")
  });
  const {
    actor: sessionActor,
    projection: workspaceProjection,
    assets: {
      assetBase64,
      assetMeta,
      assetHydrationProgress,
      setAssetHydrationProgress,
      assetBase64Ref,
      assetLoadFailedRef,
      reconcileAssetCatalog,
      ensureLiveAssetLoaded
    },
    status: {
      loaded: workspaceLoaded,
      offline: workspaceOffline,
      contentReplaced,
      syncPending: workspaceSyncPending
    },
    commands: {
      refresh: refreshProjectData,
      selectActivePath,
      updateDocumentContent
    }
  } = workspaceSession;
  const {
    scope: { generation: workspaceSessionGeneration },
    nodes,
    projectType,
    latexEngine,
    entryFilePath,
    contentEpoch,
    activePath,
    documents: docs,
    documentIdentities,
    offlineMessage: workspaceOfflineMessage
  } = workspaceProjection;
  const backgroundLatexBuild = useBackgroundLatexBuild({
    projectId,
    userId: authUser?.user_id ?? null,
    enabled:
      featureAvailability.backgroundProcessing && projectType === "latex"
  });
  const {
    error: projectActionError,
    copyDialog,
    setCopyDialog,
    copyBusy,
    createProjectFromTemplate,
    renameCurrentProject: submitProjectRename
  } = useWorkspaceProjectActions({
    projectId,
    sessionGeneration: workspaceSessionGeneration,
    project,
    authUser,
    navigate,
    refreshProjects,
    t
  });
  const {
    error: revisionError,
    revisions,
    hasMore: revisionsHasMore,
    loadingMore: revisionsLoadingMore,
    activeRevisionId,
    documents: revisionDocs,
    nodes: revisionNodes,
    entryFilePath: revisionEntryFilePath,
    assetBase64: revisionAssetBase64,
    assetMeta: revisionAssetMeta,
    loading: revisionLoading,
    createRevision,
    clearSelection: clearRevisionSelection,
    loadMore: loadMoreRevisions,
    open: openRevision
  } = useWorkspaceRevisions({
    projectId,
    sessionGeneration: workspaceSessionGeneration,
    workspaceLoaded,
    enabled: featureAvailability.revisions,
    visible: revisionPanelActive,
    projectType,
    liveDocs: docs,
    liveAssets: assetBase64,
    liveAssetMeta: assetMeta,
    t
  });

  const isRevisionMode = !!activeRevisionId;
  const {
    error: fileActionError,
    filesDropActive,
    setFilesDropActive,
    contextMenu,
    requestContextMenu,
    pathDialog,
    setPathDialog,
    addPath,
    renamePath,
    removePath,
    submitPathDialog,
    uploadFromPicker,
    onTreeDrop,
    downloadArchive
  } = useWorkspaceFileActions({
    projectId,
    sessionGeneration: workspaceSessionGeneration,
    projectName: project?.name ?? "",
    projectType,
    contentEpoch,
    activePath,
    entryFilePath,
    canWrite: !!canWrite,
    isRevisionMode,
    selectActivePath,
    updateDocumentContent,
    refreshProjectData,
    t
  });
  const currentNodes = isRevisionMode ? revisionNodes : nodes;
  const sourceAssetBase64 = isRevisionMode ? revisionAssetBase64 : assetBase64;
  const sourceAssetMeta = isRevisionMode ? revisionAssetMeta : assetMeta;
  const sourceEntryFilePath = isRevisionMode ? revisionEntryFilePath : entryFilePath;
  const sourceDocs = isRevisionMode ? revisionDocs : docs;
  const workspaceError =
    workspaceOfflineMessage ??
    fileActionError ??
    projectActionError ??
    revisionError;

  const {
    tree,
    expandedDirs,
    setExpandedDirs,
    openTreePath
  } = useProjectTree(currentNodes, activePath, selectActivePath);

  const {
    realtimeCatchUpSequence,
    workspaceChangeSequence,
    workspaceStructuralChangeSequence,
    workspaceDocumentChanges
  } = useProjectRealtime({
    projectId,
    workspaceLoaded,
    effectiveUserId,
    shareToken: shareToken ?? null,
    guestSession: shareGuestSession
  });
  const {
    lastSavedDocument,
    presence: presenceSessions,
    realtimeStatus,
    reconnectState,
    docText,
    realtimeDocReady,
    realtimeBoundPath,
    hasActiveLiveDoc,
    applyDocumentDeltas,
    replaceActiveDocumentText,
    readActiveDocumentText,
    sendCursor,
    reconnectNow,
    sendSyncSnapshot
  } = useRealtimeDoc({
    projectId,
    activePath,
    docs,
    documentIdentities,
    workspaceLoaded,
    isRevisionMode,
    canWrite: !!canWrite,
    effectiveUserId,
    effectiveUserName,
    shareToken: shareToken ?? null,
    guestSession: shareGuestSession
  });
  const syncWorkspaceFromServer = useWorkspaceRemoteSync({
    sessionActor,
    workspaceSyncPending,
    realtimeCatchUpSequence,
    workspaceChangeSequence,
    workspaceStructuralChangeSequence,
    workspaceDocumentChanges,
    isRevisionMode,
    hasActiveLiveDocument: hasActiveLiveDoc,
    activeLiveDocumentReady: realtimeDocReady,
    activeDocumentText: docText,
    lastSavedDocument,
    reconcileAssetCatalog
  });

  const {
    world: compileWorld,
    target: compileTarget,
    requiredAssetPaths,
    activeLiveDocumentReady: compileActiveLiveDocReady
  } = useWorkspaceCompileInputs({
    projectId,
    activeRevisionId,
    isRevisionMode,
    projectType,
    latexEngine,
    entryFilePath: sourceEntryFilePath,
    documents: sourceDocs,
    assetBase64: sourceAssetBase64,
    liveAssetMeta: assetMeta,
    activePath,
    activeDocumentText: docText,
    hasActiveLiveDocument: hasActiveLiveDoc,
    realtimeDocumentReady: realtimeDocReady,
    realtimeBoundPath,
    typstPreviewRenderer
  });
  const {
    vectorData,
    vectorDataOutdated,
    mapping: typstMapping,
    mappingRef: typstMappingRef,
    pdfData,
    pdfDataOutdated,
    errors: compileErrors,
    diagnostics: compileDiagnostics,
    active: compileActive,
    runtimeStatus: compileRuntimeStatus,
    pdfExportActive,
    reportPreviewError,
    downloadPdf: downloadCompiledPdf
  } = useWorkspaceCompilation({
    projectId,
    sessionGeneration: workspaceSessionGeneration,
    workspaceLoaded,
    showPreview: effectiveShowPreviewPanel,
    isRevisionMode,
    workspaceSyncPending,
    hasActiveLiveDoc,
    activeLiveDocReady: compileActiveLiveDocReady,
    world: compileWorld,
    target: compileTarget,
    requiredAssetPaths,
    loadedAssetBase64: assetBase64,
    failedAssetPathsRef: assetLoadFailedRef,
    locale,
    t
  });
  useWorkspaceAssetHydration({
    projectId,
    workspaceLoaded,
    workspaceSyncPending,
    revisionMode: isRevisionMode,
    activePath,
    assetBase64,
    assetMeta,
    requiredAssetPaths,
    assetBase64Ref,
    failedAssetPathsRef: assetLoadFailedRef,
    setProgress: setAssetHydrationProgress,
    synchronizeWorkspace: syncWorkspaceFromServer,
    ensureAssetLoaded: ensureLiveAssetLoaded
  });
  const {
    jumpTarget,
    clearJumpTarget,
    resolveSourceClickToPreview,
    handlePreviewPositionClick,
    jumpToDiagnostic
  } = useWorkspaceSourceNavigation({
    activePath,
    sessionGeneration: workspaceSessionGeneration,
    sessionActor,
    world: compileWorld,
    mappingRef: typstMappingRef,
    singlePanelMode,
    selectCompactPanel,
    selectActivePath,
    setExpandedDirs
  });

  const previewPixelPerPt = pixelPerPtForZoom(previewFitMode, previewZoom);
  const previewArtifactKind: "pdf" | "typst-vector" =
    projectType === "latex"
      ? "pdf"
      : typstPreviewRenderer === "canvas"
        ? "typst-vector"
        : pdfData
          ? "pdf"
          : "typst-vector";
  const previewOutdated =
    previewArtifactKind === "typst-vector"
      ? vectorDataOutdated
      : pdfDataOutdated;
  const {
    canvasPreviewRef,
    previewRenderTick,
    previewIsPanning,
    previewRendering,
    previewReplacing,
    hasPreviewPage,
    previewPageCurrent,
    previewPageTotal,
    jumpToPreviewPage,
    jumpToPreviewPosition,
    handlePreviewClick,
    beginPreviewPan
  } = usePreviewCanvas({
    typstRuntimeBaseUrl: compilationEnvironment.typst.runtimeBaseUrl,
    showPreviewPanel: effectiveShowPreviewPanel,
    previewArtifactKind,
    vectorData,
    pdfData,
    typstMappingRevision: typstMapping?.revision ?? null,
    previewPixelPerPt,
    previewFitMode,
    previewZoom,
    setPreviewZoom,
    onRequestManualZoom: (updater) => {
      setPreviewFitMode("manual");
      setPreviewZoom((value) =>
        clampNumber(
          updater(value),
          PREVIEW_MANUAL_MIN_ZOOM,
          PREVIEW_MAX_ZOOM
        )
      );
    },
    layoutKey: [
      editorRatio,
      effectiveShowFilesPanel,
      effectiveShowPreviewPanel,
      effectiveShowSettingsPanel,
      revisionPanelActive
    ].join(":"),
    onRenderError: reportPreviewError,
    renderErrorFallback: t("errors.previewRender"),
    initialViewportAnchor: previewInitialAnchor,
    onViewportAnchorChange: handleViewportAnchorChange,
    onTypstPreviewClick: handlePreviewPositionClick
  });
  useWorkspacePreviewThumbnail({
    projectId,
    workspaceLoaded,
    revisionMode: isRevisionMode,
    previewVisible: effectiveShowPreviewPanel,
    authenticated: !!authUser,
    previewReady: !!vectorData || !!pdfData,
    previewRenderTick,
    compileErrorCount: compileErrors.length,
    compileDiagnosticCount: compileDiagnostics.length,
    previewContainerRef: canvasPreviewRef
  });

  async function handleTypstSourceClick(position: {
    line: number;
    column: number;
    offset: number;
  }) {
    const target = await resolveSourceClickToPreview(
      position,
      previewPageCurrent - 1
    );
    if (!target) return;
    if (singlePanelMode) selectCompactPanel("preview");
    jumpToPreviewPosition(target);
  }

  const collaborators = useMemo(() => {
    const members = new Map<
      string,
      { id: string; name: string; canWrite: boolean; sessionCount: number }
    >();
    for (const session of presenceSessions) {
      const previous = members.get(session.userId);
      members.set(session.userId, {
        id: session.userId,
        name:
          session.userName && !looksLikeUuid(session.userName)
            ? session.userName
            : looksLikeUuid(session.userId)
              ? "Collaborator"
              : session.userId,
        canWrite: previous?.canWrite === true || session.canWrite,
        sessionCount: (previous?.sessionCount ?? 0) + 1,
      });
    }
    const users = Array.from(members.values());
    if (!users.some((peer) => peer.id === effectiveUserId)) {
      users.unshift({
        id: effectiveUserId,
        name: effectiveUserName,
        canWrite,
        sessionCount: 1,
      });
    }
    return users;
  }, [canWrite, effectiveUserId, effectiveUserName, presenceSessions]);

  const remoteCursors = useMemo(
    () =>
      presenceSessions
        .filter((session) => !session.isCurrentConnection && session.canWrite)
        .map((session) => {
          const name =
            session.userName && !looksLikeUuid(session.userName)
              ? session.userName
              : looksLikeUuid(session.userId)
                ? "Collaborator"
                : session.userId;
          return {
            id: session.connectionId,
            name,
            color: presenceColor(session.connectionId),
            line: session.line,
            column: session.column,
          };
        }),
    [presenceSessions]
  );
  const presenceMembershipKey = useMemo(
    () =>
      collaborators
        .map((peer) => `${peer.id}:${peer.canWrite ? "write" : "read"}`)
        .sort()
        .join("|"),
    [collaborators]
  );
  const activeAsset = sourceAssetMeta[activePath];
  const activeAssetBase64 = sourceAssetBase64[activePath];
  const activeAssetType = inferContentType(activePath, activeAsset?.contentType);
  const assetDataUrl = activeAssetBase64 ? `data:${activeAssetType};base64,${activeAssetBase64}` : "";
  const activePathExistsInTree = currentNodes.some((node) => node.kind === "file" && node.path === activePath);
  const activePathIsTextFile = isTextFile(activePath);
  const isActiveTextDoc = isRevisionMode
    ? Object.prototype.hasOwnProperty.call(revisionDocs, activePath)
    : hasActiveLiveDoc;
  const editorDocumentText = isRevisionMode
    ? revisionDocs[activePath] ?? ""
    : realtimeDocReady
      ? docText
      : workspaceOffline
        ? docs[activePath] ?? ""
        : docText;
  const activeLiveDocReady =
    !isRevisionMode &&
    hasActiveLiveDoc &&
    realtimeDocReady &&
    realtimeBoundPath === activePath;
  const aiWorkspaceScopeId = `${workspaceSessionGeneration}:${
    isRevisionMode ? `revision:${activeRevisionId}` : "live"
  }`;
  const aiWorkspaceSource = useMemo<AiWorkspaceToolSource>(() => ({
    scopeId: aiWorkspaceScopeId,
    projectType,
    mode: isRevisionMode ? "revision" : "live",
    entryFilePath: sourceEntryFilePath,
    activePath,
    nodes: currentNodes,
    documents: sourceDocs,
    activeDocument:
      isActiveTextDoc && (isRevisionMode || activeLiveDocReady || workspaceOffline)
        ? { path: activePath, text: editorDocumentText }
        : null,
    documentIdentities: isRevisionMode ? {} : documentIdentities
  }), [
    activeLiveDocReady,
    activePath,
    aiWorkspaceScopeId,
    currentNodes,
    documentIdentities,
    editorDocumentText,
    isActiveTextDoc,
    isRevisionMode,
    projectType,
    sourceDocs,
    sourceEntryFilePath,
    workspaceOffline
  ]);
  const aiWorkspaceSourceRef = useRef(aiWorkspaceSource);
  useLayoutEffect(() => {
    aiWorkspaceSourceRef.current = aiWorkspaceSource;
  }, [aiWorkspaceSource]);
  const getAiWorkspaceSource = useCallback(() => {
    const source = aiWorkspaceSourceRef.current;
    if (source.mode !== "live") return source;
    const latestText = readActiveDocumentText();
    if (latestText === null) return source;
    if (
      source.activeDocument?.path === source.activePath &&
      source.activeDocument.text === latestText
    ) return source;
    return {
      ...source,
      activeDocument: { path: source.activePath, text: latestText }
    };
  }, [readActiveDocumentText]);
  const aiWorkspaceAllowsEdits = !!canWrite && !isRevisionMode;
  const aiCandidateAssetsReady = !requiredAssetPaths.some(
    (path) => !assetBase64[path] && !assetLoadFailedRef.current.has(path)
  );
  const aiCandidateCompileRevision = useMemo(() => ({
    world: compileWorld,
    target: compileTarget,
    ready:
      workspaceLoaded &&
      !workspaceSyncPending &&
      compileActiveLiveDocReady &&
      aiCandidateAssetsReady
  }), [
    aiCandidateAssetsReady,
    compileActiveLiveDocReady,
    compileTarget,
    compileWorld,
    workspaceLoaded,
    workspaceSyncPending
  ]);
  const aiCandidateCompileRevisionRef = useRef(aiCandidateCompileRevision);
  useLayoutEffect(() => {
    aiCandidateCompileRevisionRef.current = aiCandidateCompileRevision;
  }, [aiCandidateCompileRevision]);
  const verifyAiCandidate = useCallback(async (
    candidate: { path: string; baseText: string; candidateText: string },
    signal?: AbortSignal
  ): Promise<AiWorkspaceCandidateCompileResult> => {
    let revision = aiCandidateCompileRevisionRef.current;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (revision.world.source(candidate.path) === candidate.baseText) break;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      revision = aiCandidateCompileRevisionRef.current;
    }
    if (!revision.ready) {
      return {
        outcome: "unavailable",
        reason: "workspace_sync_pending"
      };
    }
    if (revision.world.source(candidate.path) !== candidate.baseText) {
      return {
        outcome: "unavailable",
        reason: "compiler_world_stale"
      };
    }
    const candidateWorld = compileWorldWithCandidateDocument(
      revision.world,
      candidate.path,
      candidate.candidateText
    );
    if (!candidateWorld) {
      return {
        outcome: "unavailable",
        reason: "document_missing"
      };
    }
    const output = await compileWorkspaceCandidate(
      compilationEnvironment,
      candidateWorld,
      revision.target,
      candidate.path,
      signal
    );
    return {
      outcome: "completed",
      revision,
      errors: output.errors,
      diagnostics: output.diagnostics
    };
  }, [compilationEnvironment]);
  const isAiCandidateRevisionCurrent = useCallback(
    (revision: object) => aiCandidateCompileRevisionRef.current === revision,
    []
  );
  const assistantEditReviewCoordinator = useMemo(
    () => new AssistantEditReviewCoordinator(aiWorkspaceScopeId),
    [aiWorkspaceScopeId]
  );
  useEffect(
    () => () => assistantEditReviewCoordinator.dispose(),
    [assistantEditReviewCoordinator]
  );
  const assistantEditReviewSnapshot = useSyncExternalStore(
    assistantEditReviewCoordinator.subscribe,
    assistantEditReviewCoordinator.getSnapshot,
    assistantEditReviewCoordinator.getSnapshot
  );
  const assistantEditProposal = assistantEditReviewSnapshot.proposal;
  const aiWorkspaceContext = useMemo<AiWorkspaceContextSnapshot>(() => {
    const files = currentNodes.filter((node) => node.kind === "file");
    const textFiles = files.filter((node) => isTextFile(node.path)).length;
    const diagnosticErrors = compileDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error"
    ).length;
    const warningCount = compileDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning"
    ).length;
    const compilationFailed = compileErrors.length > 0 || diagnosticErrors > 0;
    const compiling =
      !compilationFailed &&
      (previewOutdated ||
        compileActive ||
        [
          "downloading-compiler",
          "downloading-package",
          "compiling"
        ].includes(compileRuntimeStatus.stage));
    const compilationState = !workspaceLoaded || workspaceSyncPending
      ? "unavailable" as const
      : compiling
        ? "running" as const
        : compilationFailed
          ? "failed" as const
          : vectorData || pdfData
            ? "succeeded" as const
            : "idle" as const;
    return {
      schema: 1,
      project_name: project.name,
      project_type: projectType,
      mode: isRevisionMode ? "revision" : "live",
      entry_file_path: sourceEntryFilePath,
      active_path: activePath,
      access: aiWorkspaceAllowsEdits ? "edit" : "read",
      workspace_state: workspaceOffline
        ? "offline"
        : !workspaceLoaded || workspaceSyncPending
          ? "syncing"
          : "ready",
      active_document_state:
        isActiveTextDoc && (isRevisionMode || activeLiveDocReady || workspaceOffline)
          ? "ready"
          : "unavailable",
      files: {
        total: files.length,
        text: textFiles,
        assets: files.length - textFiles
      },
      compilation: {
        state: compilationState,
        errors: Math.max(compileErrors.length, diagnosticErrors),
        warnings: warningCount
      },
      pending_edit_review: assistantEditProposal !== null,
      last_edit_review: assistantEditReviewSnapshot.outcomes.length > 0
        ? {
            review_id: assistantEditReviewSnapshot.outcomes.at(-1)!.reviewId,
            decision: assistantEditReviewSnapshot.outcomes.at(-1)!.decision
          }
        : null
    };
  }, [
    activeLiveDocReady,
    activePath,
    aiWorkspaceAllowsEdits,
    assistantEditProposal,
    assistantEditReviewSnapshot.outcomes,
    compileActive,
    compileDiagnostics,
    compileErrors.length,
    compileRuntimeStatus.stage,
    currentNodes,
    isActiveTextDoc,
    isRevisionMode,
    pdfData,
    previewOutdated,
    project.name,
    projectType,
    sourceEntryFilePath,
    vectorData,
    workspaceLoaded,
    workspaceOffline,
    workspaceSyncPending
  ]);
  const aiWorkspaceContextRef = useRef(aiWorkspaceContext);
  useLayoutEffect(() => {
    aiWorkspaceContextRef.current = aiWorkspaceContext;
  }, [aiWorkspaceContext]);
  const getAiWorkspaceContext = useCallback(
    () => aiWorkspaceContextRef.current,
    []
  );
  const aiWorkspaceCompilation = useMemo<AiWorkspaceCompilationSnapshot>(() => ({
    state: aiWorkspaceContext.compilation.state,
    diagnosticsCurrent: aiWorkspaceContext.compilation.state === "succeeded" ||
      aiWorkspaceContext.compilation.state === "failed",
    errors: compileErrors,
    diagnostics: compileDiagnostics
  }), [aiWorkspaceContext.compilation.state, compileDiagnostics, compileErrors]);
  const aiWorkspaceCompilationRef = useRef(aiWorkspaceCompilation);
  useLayoutEffect(() => {
    aiWorkspaceCompilationRef.current = aiWorkspaceCompilation;
  }, [aiWorkspaceCompilation]);
  const getAiWorkspaceCompilation = useCallback(
    () => aiWorkspaceCompilationRef.current,
    []
  );
  const aiWorkspacePort = useMemo(
    () => createAiWorkspacePort({
      scopeId: aiWorkspaceScopeId,
      projectType,
      mode: isRevisionMode ? "revision" : "live",
      allowEdits: aiWorkspaceAllowsEdits,
      typstPackageSource: compilationEnvironment.typst.packageSource,
      getContextSnapshot: getAiWorkspaceContext,
      getCompilationSnapshot: getAiWorkspaceCompilation,
      getSource: getAiWorkspaceSource,
      verifyCandidate: verifyAiCandidate,
      isCandidateRevisionCurrent: isAiCandidateRevisionCurrent,
      requestEditReview: (proposal, signal) =>
        assistantEditReviewCoordinator.request(proposal, signal)
    }),
    [
      aiWorkspaceAllowsEdits,
      aiWorkspaceScopeId,
      assistantEditReviewCoordinator,
      compilationEnvironment.typst.packageSource,
      getAiWorkspaceCompilation,
      getAiWorkspaceContext,
      getAiWorkspaceSource,
      isAiCandidateRevisionCurrent,
      isRevisionMode,
      projectType,
      verifyAiCandidate
    ]
  );
  useEffect(() => () => aiWorkspacePort.dispose(), [aiWorkspacePort]);
  const assistantEditProposalIsCurrent = !!assistantEditProposal &&
    aiWorkspaceAllowsEdits &&
    activeLiveDocReady &&
    assistantEditProposal.path === activePath &&
    assistantEditProposal.baseText === editorDocumentText &&
    isAiCandidateRevisionCurrent(assistantEditProposal.verificationRevision);
  useEffect(() => {
    if (assistantEditProposal && singlePanelMode) selectCompactPanel("editor");
  }, [assistantEditProposal, selectCompactPanel, singlePanelMode]);
  useEffect(() => {
    if (!assistantEditProposal || assistantEditProposalIsCurrent) return;
    assistantEditReviewCoordinator.markStale(assistantEditProposal.id);
    if (singlePanelMode) selectCompactPanel(AI_ASSISTANT_PANEL_ID);
  }, [
    assistantEditProposal,
    assistantEditProposalIsCurrent,
    assistantEditReviewCoordinator,
    selectCompactPanel,
    singlePanelMode
  ]);
  const rejectAssistantEdit = useCallback(() => {
    if (!assistantEditProposal) return;
    assistantEditReviewCoordinator.reject(assistantEditProposal.id);
    if (singlePanelMode) selectCompactPanel(AI_ASSISTANT_PANEL_ID);
  }, [
    assistantEditProposal,
    assistantEditReviewCoordinator,
    selectCompactPanel,
    singlePanelMode
  ]);
  const acceptAssistantEdit = useCallback(() => {
    if (!assistantEditProposal) return;
    if (!isAiCandidateRevisionCurrent(assistantEditProposal.verificationRevision)) {
      assistantEditReviewCoordinator.markStale(assistantEditProposal.id);
      if (singlePanelMode) selectCompactPanel(AI_ASSISTANT_PANEL_ID);
      return;
    }
    const outcome = replaceActiveDocumentText(
      assistantEditProposal.path,
      assistantEditProposal.baseText,
      assistantEditProposal.candidateText
    );
    if (outcome === "applied") {
      assistantEditReviewCoordinator.accept(assistantEditProposal.id);
    } else {
      assistantEditReviewCoordinator.markStale(assistantEditProposal.id);
    }
    if (singlePanelMode) selectCompactPanel(AI_ASSISTANT_PANEL_ID);
  }, [
    assistantEditProposal,
    assistantEditReviewCoordinator,
    isAiCandidateRevisionCurrent,
    replaceActiveDocumentText,
    selectCompactPanel,
    singlePanelMode
  ]);
  const isActiveEditableTextDoc = isActiveTextDoc && activePathIsTextFile;
  const currentEditorLanguage = editorLanguageForPath(activePath);
  const previewPercent = Math.round(previewZoom * 100);
  const activeFileName = activePath.split("/").filter(Boolean).at(-1) || activePath;
  const realtimeRequired = isActiveEditableTextDoc && !isRevisionMode;
  const reconnectNoticeActive = reconnectState.attempt >= 2;
  const connectionOnline =
    !workspaceOffline &&
    (!realtimeRequired || realtimeStatus === "connected" || !reconnectNoticeActive);
  const showConnectionWarning =
    realtimeRequired && reconnectNoticeActive && !connectionOnline;
  const projectReadOnly = !canWrite;
  const reconnectCountdownText = t("workspace.connectionLostReconnecting", {
    seconds: Math.max(0, reconnectState.secondsRemaining)
  });
  const createCurrentRevision = useCallback(
    async (summary: string) => {
      if (activeLiveDocReady && !(await sendSyncSnapshot())) {
        throw new Error(t("revisions.syncFailed"));
      }
      await createRevision(summary);
    },
    [activeLiveDocReady, createRevision, sendSyncSnapshot, t]
  );
  const saveActiveDocumentNow = useCallback(() => {
    if (
      !projectId ||
      !activePath ||
      !workspaceLoaded ||
      isRevisionMode ||
      !activeLiveDocReady ||
      !hasActiveLiveDoc ||
      !canWrite
    ) {
      return;
    }
    void sendSyncSnapshot();
  }, [
    activeLiveDocReady,
    activePath,
    canWrite,
    hasActiveLiveDoc,
    isRevisionMode,
    projectId,
    sendSyncSnapshot,
    workspaceLoaded,
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || compileWorld.projectType !== "typst") {
      return;
    }
    void prewarmTypstClientSide({
      environment: compilationEnvironment.typst,
      documents: compileWorld.documents.slice()
    }).catch(() => undefined);
  }, [compilationEnvironment.typst, compileWorld, projectId, workspaceLoaded]);

  useEffect(() => {
    if (revisionPanelActive) return;
    if (!activeRevisionId) return;
    clearRevisionSelection();
  }, [activeRevisionId, clearRevisionSelection, revisionPanelActive]);

  useEffect(() => {
    if (contentReplaced) window.location.reload();
  }, [contentReplaced]);

  function increasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => nextManualPreviewZoom(value, "in"));
  }

  function decreasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => nextManualPreviewZoom(value, "out"));
  }


  function setPreviewFitWholePage() {
    setPreviewFitMode("page");
  }

  function setPreviewFitPageWidth() {
    setPreviewFitMode("width");
  }

  function openTreePathAndFocusEditor(path: string) {
    openTreePath(path);
    if (singlePanelMode) {
      selectCompactPanel("editor");
    }
  }

  function handleEditorDelta(changes: Array<{ from: number; to: number; insert: string }>) {
    if (canRequestGuestWrite && !guestSessionToken) {
      openAuthModal();
      return false;
    }
    applyDocumentDeltas(changes);
    return true;
  }

  async function beginTemporaryGuestEditing() {
    if (await establishTemporaryGuestSession()) {
      reconnectNow();
    }
  }

  const toolbarPortal = document.getElementById("workspace-toolbar-portal");

  return (
    <>
      {toolbarPortal &&
        createPortal(
          <WorkspaceToolbar
            projectId={projectId}
            projectName={project?.name ?? ""}
            showFilesPanel={effectiveShowFilesPanel}
            showPreviewPanel={effectiveShowPreviewPanel}
            showProjectSettingsPanel={effectiveShowSettingsPanel}
            showRevisionPanel={revisionPanelActive}
            revisionsAvailable={featureAvailability.revisions}
            optionalAuxiliaryPanels={assistantPanelControl ? [assistantPanelControl] : []}
            collapsePanelsIntoMenu={collapsePanelToggles}
            singlePanelMode={singlePanelMode}
            activePanel={compactPanelView}
            onRenameProject={submitProjectRename}
            canRenameProject={!!canManageProject}
            onTogglePanel={togglePanel}
            onSelectPanel={selectCompactPanel}
            showAccountControlsInViewMenu={showAccountControlsInViewMenu}
            accountControlsAvailable={featureAvailability.accountControls}
            accountDisplayName={authUser?.display_name ?? null}
            onOpenProfile={() => navigate("/profile")}
            onLogout={async () => {
              if (onLogoutFromWorkspace) {
                await onLogoutFromWorkspace();
              }
            }}
            readOnly={projectReadOnly}
            locale={locale}
            onLocaleChange={onLocaleChange}
            t={t}
          />,
          toolbarPortal,
        )}
      <section className="workspace-shell">
      <WorkspaceAccessBanner
        project={project}
        isAnonymousShare={isAnonymousShare}
        isShareLinkContext={!!shareToken}
        isAuthenticated={!!authUser}
        saveStatus={shareSaveStatus}
        saveError={shareSaveError}
        onSaveToProjects={onSaveSharedProject}
        onRequestSignIn={openAuthModal}
        onCopyTemplate={() =>
          setCopyDialog({
            projectId: project.id,
            sourceName: project.name,
            suggestedName: `${project.name} ${t("projects.copySuffix")}`
          })
        }
        t={t}
      />
      <section className="workspace-stage">
        {effectiveShowFilesPanel && (
          <>
            <FileTreePanel
              width={filesPanelWidth}
              filesDropActive={filesDropActive}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFilesDropActive(true);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget as Node | null;
                if (!(event.currentTarget as HTMLElement).contains(nextTarget)) {
                  setFilesDropActive(false);
                }
              }}
              onDrop={onTreeDrop}
              canWrite={!!canWrite}
              isRevisionMode={isRevisionMode}
              onAddFile={() => addPath("file")}
              onAddDirectory={() => addPath("directory")}
              onUpload={() => uploadFromPicker()}
              onDownloadArchive={downloadArchive}
              tree={tree}
              activePath={activePath}
              expandedDirs={expandedDirs}
              setExpandedDirs={setExpandedDirs}
              onOpenTreePath={openTreePathAndFocusEditor}
              onRequestContextMenu={requestContextMenu}
              t={t}
            />
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize(resizeFilesPanel)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("workspace.resizeFiles")}
              />
            )}
          </>
        )}

        <div className="center-split" ref={centerSplitRef}>
          {effectiveShowEditorPanel && (
            <EditorPanel
              activePath={activePath}
              activeFileName={activeFileName}
              lineWrapEnabled={lineWrapEnabled}
              onToggleLineWrap={() => setLineWrapEnabled((value) => !value)}
              collaborators={collaborators}
              remoteCursors={remoteCursors}
              connectionOnline={connectionOnline}
              isActiveEditableTextDoc={isActiveEditableTextDoc}
              docText={editorDocumentText}
              onEditorDelta={handleEditorDelta}
              onSave={saveActiveDocumentNow}
              onCursorChange={sendCursor}
              onSourceClick={handleTypstSourceClick}
              readOnly={
                isRevisionMode ||
                (!canWrite && !canRequestGuestWrite) ||
                (!isRevisionMode && !activeLiveDocReady)
              }
              currentEditorLanguage={currentEditorLanguage}
              jumpTarget={jumpTarget}
              onJumpHandled={clearJumpTarget}
              isRevisionMode={isRevisionMode}
              canWrite={!!canWrite}
              canRequestGuestWrite={!!canRequestGuestWrite}
              realtimeDocReady={realtimeDocReady}
              activeAssetBase64={activeAssetBase64}
              activeAssetIsImage={isImageAsset(activePath, activeAssetType)}
              activeAssetIsPdf={isPdfAsset(activePath, activeAssetType)}
              assetDataUrl={assetDataUrl}
              workspaceError={workspaceError}
              showConnectionWarning={showConnectionWarning}
              realtimeStatus={realtimeStatus}
              reconnectState={reconnectState}
              reconnectCountdownText={reconnectCountdownText}
              onReconnectNow={reconnectNow}
              activePathExistsInTree={activePathExistsInTree}
              editorOverride={assistantEditProposal ? (
                <AssistantEditReviewPane
                  proposal={assistantEditProposal}
                  canAccept={assistantEditProposalIsCurrent}
                  onReject={rejectAssistantEdit}
                  onAccept={acceptAssistantEdit}
                  t={t}
                />
              ) : null}
              panelStyle={
                effectiveShowPreviewPanel
                  ? { flex: `${editorRatio} 1 0`, minWidth: 320 }
                  : { flex: "1 1 auto", minWidth: 320 }
              }
              t={t}
            />
          )}

          {!singlePanelMode && effectiveShowEditorPanel && effectiveShowPreviewPanel && (
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) => {
                const totalWidth = centerSplitRef.current?.getBoundingClientRect().width ?? 1;
                resizeEditorSplit(dx, totalWidth);
              })}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("workspace.resizeEditorPreview")}
            />
          )}

          {effectiveShowPreviewPanel && (
            <PreviewPanel
              editorRatio={editorRatio}
              previewFitMode={previewFitMode}
              previewPercent={previewPercent}
              previewPageCurrent={previewPageCurrent}
              previewPageTotal={previewPageTotal}
              canDownloadPdf={
                (!!pdfData && !pdfDataOutdated) ||
                (projectType === "typst" &&
                  !!vectorData &&
                  !vectorDataOutdated &&
                  compileErrors.length === 0)
              }
              pdfExportActive={pdfExportActive}
              compileRuntimeStatus={compileRuntimeStatus}
              compileKind={projectType}
              workspaceSyncPending={workspaceSyncPending}
              compileActive={compileActive}
              previewRendering={previewRendering}
              previewReplacing={previewReplacing}
              previewOutdated={previewOutdated}
              assetHydrationProgress={assetHydrationProgress}
              previewIsPanning={previewIsPanning}
              compileDiagnostics={compileDiagnostics}
              compileErrors={compileErrors}
              hasPreviewPage={hasPreviewPage}
              canvasPreviewRef={canvasPreviewRef}
              onBeginPreviewPan={beginPreviewPan}
              onPreviewClick={handlePreviewClick}
              onSetFitWholePage={setPreviewFitWholePage}
              onSetFitPageWidth={setPreviewFitPageWidth}
              onDecreaseZoom={decreasePreviewZoom}
              onIncreaseZoom={increasePreviewZoom}
              onJumpToPage={jumpToPreviewPage}
              onDownloadPdf={downloadCompiledPdf}
              backgroundBuild={backgroundLatexBuild}
              onJumpToDiagnostic={jumpToDiagnostic}
              t={t}
            />
          )}
        </div>

        {assistantPanelMounted && aiAssistantEnabled && (
          <>
            {!singlePanelMode && assistantPanelActive && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize(resizeAuxiliaryPanel)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("workspace.resizeAssistant")}
              />
            )}
            <div
              className="workspace-optional-panel-host"
              hidden={!assistantPanelActive}
            >
              <AiAssistantPanel
                key={`${effectiveUserId}:${projectId}:${aiWorkspaceScopeId}:${
                  aiWorkspaceAllowsEdits ? "write" : "read"
                }`}
                width={auxiliaryPanelWidth}
                accountId={authUser?.user_id ?? null}
                projectId={projectId}
                locale={locale}
                workspacePort={aiWorkspacePort}
                editReviewOutcomes={assistantEditReviewSnapshot.outcomes}
                aiAssistantConfig={authConfig?.ai_assistant ?? null}
                onOpenSettings={openAssistantSettings}
                t={t}
              />
            </div>
          </>
        )}

        {effectiveShowSettingsPanel && (
          <>
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize(resizeAuxiliaryPanel)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("workspace.resizeSettings")}
              />
            )}
            {isAnonymousShare ? (
              <aside className="panel panel-right settings-panel" style={{ width: auxiliaryPanelWidth }}>
                <div className="panel-header">
                  <h2>{t("workspace.settings")}</h2>
                </div>
                <div className="panel-content settings-body">
                  {assistantSettingsSection?.content}
                  <div className="settings-card">
                    <p>{t("share.settingsLoginRequired")}</p>
                    <UiButton
                      onClick={openAuthModal}
                    >
                      {t("share.logIn")}
                    </UiButton>
                  </div>
                </div>
              </aside>
            ) : (
              <WorkspaceSettingsContainer
                key={workspaceSessionGeneration}
                width={auxiliaryPanelWidth}
                project={project}
                organizations={organizations}
                authConfig={authConfig ?? null}
                permissions={{
                  canManageProject: !!canManageProject,
                  canViewWriteShareLink: !!canViewWriteShareLink
                }}
                projectAccessEnabled={featureAvailability.projectAccess}
                externalRepositoriesEnabled={
                  featureAvailability.externalRepositories
                }
                preview={{
                  renderer: typstPreviewRenderer,
                  setRenderer: setTypstPreviewRenderer
                }}
                presenceMembershipKey={presenceMembershipKey}
                projection={workspaceProjection}
                sessionActor={sessionActor}
                refreshProjects={refreshProjects}
                optionalSections={assistantSettingsSection ? [assistantSettingsSection] : []}
                preferredSection={preferredSettingsSection}
                t={t}
              />
            )}
          </>
        )}

        {revisionPanelActive && (
          <>
            {!singlePanelMode && (
              <div
                className="panel-resizer"
                onMouseDown={beginHorizontalResize(resizeAuxiliaryPanel)}
                role="separator"
                aria-orientation="vertical"
                aria-label={t("workspace.resizeRevisions")}
              />
            )}
            <RevisionsPanel
              width={auxiliaryPanelWidth}
              revisions={revisions}
              activeRevisionId={activeRevisionId}
              loading={revisionLoading.active}
              loadingRevisionId={revisionLoading.revisionId}
              loadingBytes={revisionLoading.loadedBytes}
              loadingTotalBytes={revisionLoading.totalBytes}
              hasMore={revisionsHasMore}
              loadingMore={revisionsLoadingMore}
              canWrite={!!canWrite}
              isRevisionMode={isRevisionMode}
              onCreateRevision={createCurrentRevision}
              onOpenRevision={openRevision}
              onLoadMore={loadMoreRevisions}
              locale={locale}
              t={t}
            />
          </>
        )}
      </section>

      <WorkspaceOverlays
        contextMenu={contextMenu}
        canWrite={!!canWrite}
        onAddPath={addPath}
        onUploadFromPicker={uploadFromPicker}
        onRenamePath={renamePath}
        onRemovePath={removePath}
        copyDialog={copyDialog}
        copyBusy={copyBusy}
        onCloseCopyDialog={() => setCopyDialog(null)}
        onCreateProjectFromTemplate={createProjectFromTemplate}
        onChangeCopyName={(name) =>
          setCopyDialog((current) => (current ? { ...current, suggestedName: name } : current))
        }
        pathDialog={pathDialog}
        onClosePathDialog={() => setPathDialog(null)}
        onSubmitPathDialog={submitPathDialog}
        onChangePathDialogValue={(value) =>
          setPathDialog((current) => {
            if (!current || current.mode === "delete") return current;
            return { ...current, value };
          })
        }
        authModalOpen={authModalOpen}
        canRequestGuestWrite={!!canRequestGuestWrite}
        projectName={project?.name || ""}
        isAnonymousShareTemplate={isAnonymousShare && !!project?.is_template}
        guestNameInput={guestNameInput}
        onChangeGuestNameInput={setGuestNameInput}
        onBeginTemporaryGuestEditing={beginTemporaryGuestEditing}
        authConfig={authConfig ?? null}
        onSignedIn={handleAuthModalSignedIn}
        guestAuthError={guestAuthError}
        guestAuthPending={guestAuthPending}
        onCloseAuthModal={closeAuthModal}
        t={t}
      />
      </section>
    </>
  );
}
