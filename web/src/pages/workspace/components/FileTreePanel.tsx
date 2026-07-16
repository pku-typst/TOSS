import type { DragEvent as ReactDragEvent } from "react";
import "@/pages/workspace/file-tree.css";
import { Archive, FilePlus2, FolderPlus, Upload } from "lucide-react";
import { UiIconButton } from "@/components/ui";
import { TreeNodeRow } from "@/pages/workspace/components/TreeNodeRow";
import type { ContextMenuState, ProjectTreeNodeView } from "@/pages/workspace/types";
import type { Translator } from "@/lib/i18n";

export function FileTreePanel({
  width,
  filesDropActive,
  onDragOver,
  onDragLeave,
  onDrop,
  canWrite,
  isRevisionMode,
  onAddFile,
  onAddDirectory,
  onUpload,
  onDownloadArchive,
  tree,
  activePath,
  expandedDirs,
  setExpandedDirs,
  onOpenTreePath,
  onRequestContextMenu,
  t
}: {
  width: number;
  filesDropActive: boolean;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  canWrite: boolean;
  isRevisionMode: boolean;
  onAddFile: () => void;
  onAddDirectory: () => void;
  onUpload: () => void;
  onDownloadArchive: () => void;
  tree: ProjectTreeNodeView[];
  activePath: string;
  expandedDirs: Set<string>;
  setExpandedDirs: (next: Set<string>) => void;
  onOpenTreePath: (path: string) => void;
  onRequestContextMenu: (menu: ContextMenuState) => void;
  t: Translator;
}) {
  return (
    <aside className="panel panel-files" style={{ width }}>
      <div className="panel-header workspace-main-header">
        <h2>{t("workspace.files")}</h2>
        <nve-toolbar className="panel-toolbar" container="inset" content="wrap">
          <UiIconButton
            tooltip={t("workspace.newFile")}
            label={t("workspace.newFile")}
            onClick={onAddFile}
            disabled={!canWrite || isRevisionMode}
          >
            <FilePlus2 size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={t("workspace.newFolder")}
            label={t("workspace.newFolder")}
            onClick={onAddDirectory}
            disabled={!canWrite || isRevisionMode}
          >
            <FolderPlus size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={t("workspace.upload")}
            label={t("workspace.upload")}
            onClick={onUpload}
            disabled={!canWrite || isRevisionMode}
          >
            <Upload size={16} />
          </UiIconButton>
          <UiIconButton tooltip={t("preview.downloadZip")} label={t("preview.downloadZip")} onClick={onDownloadArchive}>
            <Archive size={16} />
          </UiIconButton>
        </nve-toolbar>
      </div>
      <div
        className={`panel-content ${filesDropActive ? "drop-active" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="tree">
          {tree.map((node) => (
            <TreeNodeRow
              key={node.path}
              node={node}
              activePath={activePath}
              expanded={expandedDirs}
              setExpanded={setExpandedDirs}
              onOpen={onOpenTreePath}
              canManage={canWrite && !isRevisionMode}
              onRequestContextMenu={onRequestContextMenu}
              t={t}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
