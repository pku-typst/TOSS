import { EditorPane } from "@/components/EditorPane";
import { UiBadge, UiButton } from "@/components/ui";
import { UnsupportedFilePane } from "@/pages/workspace/components/UnsupportedFilePane";
import { MonitorSmartphone, UsersRound } from "lucide-react";
import type { CSSProperties } from "react";
import type { Translator } from "@/lib/i18n";

type RemoteCursor = {
  id: string;
  name: string;
  color: string;
  line?: number;
  column?: number;
};

type Collaborator = {
  id: string;
  name: string;
  sessionCount: number;
};

export function EditorPanel({
  activePath,
  activeFileName,
  lineWrapEnabled,
  onToggleLineWrap,
  collaborators,
  remoteCursors,
  connectionOnline,
  isActiveEditableTextDoc,
  docText,
  onEditorDelta,
  onSave,
  onCursorChange,
  onSourceClick,
  readOnly,
  currentEditorLanguage,
  jumpTarget,
  onJumpHandled,
  isRevisionMode,
  canWrite,
  canRequestGuestWrite,
  realtimeDocReady,
  activeAssetBase64,
  activeAssetIsImage,
  activeAssetIsPdf,
  assetDataUrl,
  workspaceError,
  showConnectionWarning,
  realtimeStatus,
  reconnectState,
  reconnectCountdownText,
  onReconnectNow,
  activePathExistsInTree,
  panelStyle,
  t
}: {
  activePath: string;
  activeFileName: string;
  lineWrapEnabled: boolean;
  onToggleLineWrap: () => void;
  collaborators: Collaborator[];
  remoteCursors: RemoteCursor[];
  connectionOnline: boolean;
  isActiveEditableTextDoc: boolean;
  docText: string;
  onEditorDelta: (changes: Array<{ from: number; to: number; insert: string }>) => boolean;
  onSave: () => void;
  onCursorChange: (cursor: { line: number; column: number; offset: number }) => void;
  onSourceClick: (position: { line: number; column: number; offset: number }) => void;
  readOnly: boolean;
  currentEditorLanguage: "typst" | "latex" | "markdown" | "plain";
  jumpTarget: { line: number; column: number; token: number } | null;
  onJumpHandled: () => void;
  isRevisionMode: boolean;
  canWrite: boolean;
  canRequestGuestWrite: boolean;
  realtimeDocReady: boolean;
  activeAssetBase64?: string;
  activeAssetIsImage: boolean;
  activeAssetIsPdf: boolean;
  assetDataUrl: string;
  workspaceError: string | null;
  showConnectionWarning: boolean;
  realtimeStatus: string;
  reconnectState: { active: boolean };
  reconnectCountdownText: string;
  onReconnectNow: () => void;
  activePathExistsInTree: boolean;
  panelStyle: CSSProperties;
  t: Translator;
}) {
  const collaboratorCount = Math.max(1, collaborators.length);
  const editingSessionCount = Math.max(
    1,
    collaborators.reduce((count, collaborator) => count + collaborator.sessionCount, 0),
  );
  const collaboratorSummary =
    collaborators.length > 0
      ? collaborators
          .map((collaborator) =>
            collaborator.sessionCount > 1
              ? t("workspace.collaboratorSessions", {
                  name: collaborator.name,
                  count: collaborator.sessionCount,
                })
              : collaborator.name,
          )
          .join(", ")
      : t("workspace.collaboratorCount", { count: 1 });

  return (
    <article className="panel panel-editor" style={panelStyle}>
      <div className="panel-header workspace-main-header">
        <h2 title={activePath}>{activeFileName}</h2>
        <nve-toolbar className="panel-status-toolbar" container="inset" content="wrap">
          <UiButton variant="ghost" size="sm" className="editor-wrap-toggle" onClick={onToggleLineWrap}>
            {lineWrapEnabled ? t("status.wrapOn") : t("status.wrapOff")}
          </UiButton>
          <UiBadge
            tone="neutral"
            className="editor-peer-count"
            title={collaboratorSummary}
          >
            <UsersRound size={13} aria-hidden />
            <span>{collaboratorCount}</span>
          </UiBadge>
          {editingSessionCount > collaboratorCount && (
            <UiBadge
              tone="accent"
              className="editor-session-count"
              title={t("workspace.editingSessionCount", {
                count: editingSessionCount,
              })}
            >
              <MonitorSmartphone size={13} aria-hidden />
              <span>{editingSessionCount}</span>
            </UiBadge>
          )}
          <UiBadge tone={connectionOnline ? "success" : "warning"}>
            {connectionOnline ? t("status.online") : t("status.offline")}
          </UiBadge>
        </nve-toolbar>
      </div>
      <div className="panel-content flush editor-panel-content">
        {isActiveEditableTextDoc ? (
          <div className="editor-surface">
            <EditorPane
              editorInstanceKey={`${activePath}:${isRevisionMode ? "revision" : "live"}:${currentEditorLanguage}`}
              value={docText}
              onDelta={onEditorDelta}
              onSave={onSave}
              onCursorChange={onCursorChange}
              onSourceClick={onSourceClick}
              readOnly={readOnly}
              lineWrap={lineWrapEnabled}
              language={currentEditorLanguage}
              remoteCursors={remoteCursors}
              jumpTo={jumpTarget}
              onJumpHandled={onJumpHandled}
            />
          </div>
        ) : (
          <UnsupportedFilePane
            path={activePath}
            hasData={!!activeAssetBase64}
            isImage={activeAssetIsImage}
            isPdf={activeAssetIsPdf}
            dataUrl={assetDataUrl}
            t={t}
          />
        )}
        {!isActiveEditableTextDoc && <div className="error panel-inline-error">{t("workspace.notEditable")}</div>}
        {isRevisionMode && !activePathExistsInTree && (
          <div className="error panel-inline-error">{t("workspace.revisionFileMissing")}</div>
        )}
        {showConnectionWarning && realtimeStatus === "disconnected" && (
          <div className="error panel-inline-error connection-warning connection-warning-row ui-message-with-action">
            <span className="message-text">
              {reconnectState.active ? reconnectCountdownText : t("workspace.connectionLost")}
            </span>
            <UiButton size="sm" onClick={onReconnectNow}>
              {t("workspace.reconnectNow")}
            </UiButton>
          </div>
        )}
        {showConnectionWarning && realtimeStatus === "connecting" && !reconnectState.active && (
          <div className="error panel-inline-error connection-warning">{t("workspace.connectionReconnecting")}</div>
        )}
        {workspaceError && <div className="error panel-inline-error">{workspaceError}</div>}
      </div>
    </article>
  );
}
