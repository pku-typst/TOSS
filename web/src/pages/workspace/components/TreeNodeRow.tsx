import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileText, Folder, MoreVertical } from "lucide-react";
import type { ContextMenuState, ProjectTreeNodeView } from "@/pages/workspace/types";
import type { Translator } from "@/lib/i18n";

export function TreeNodeRow({
  node,
  activePath,
  expanded,
  setExpanded,
  onOpen,
  canManage,
  onRequestContextMenu,
  t
}: {
  node: ProjectTreeNodeView;
  activePath: string;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  onOpen: (path: string) => void;
  canManage: boolean;
  onRequestContextMenu: (menu: ContextMenuState) => void;
  t: Translator;
}) {
  const isExpanded = expanded.has(node.path);
  const isActive = activePath === node.path;
  const isTypstFile = node.kind === "file" && /\.typ$/i.test(node.path);
  const isImageFile = node.kind === "file" && /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(node.path);
  const isTextLikeFile = node.kind === "file" && /\.(txt|md|json|toml|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx)$/i.test(node.path);

  const toggleDirectory = () => {
    if (node.kind !== "directory") return;
    const next = new Set(expanded);
    if (isExpanded) next.delete(node.path);
    else next.add(node.path);
    setExpanded(next);
  };

  return (
    <div className="tree-branch">
      <div
        className={`tree-node ${isActive ? "active" : ""}`}
        onContextMenu={(event) => {
          if (!canManage) return;
          event.preventDefault();
          onRequestContextMenu({
            path: node.path,
            kind: node.kind,
            x: event.clientX,
            y: event.clientY
          });
        }}
      >
        {node.kind === "directory" ? (
          <nve-icon-button
            className="tree-toggle"
            role="button"
            container="flat"
            size="sm"
            aria-label={
              isExpanded
                ? t("workspace.collapseDirectory", { name: node.name })
                : t("workspace.expandDirectory", { name: node.name })
            }
            onClick={toggleDirectory}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </nve-icon-button>
        ) : (
          <span className="tree-toggle tree-placeholder" />
        )}
        <nve-button
          className="tree-label"
          role="button"
          container="flat"
          onClick={() => (node.kind === "file" ? onOpen(node.path) : toggleDirectory())}
        >
          <span className="tree-label-content">
            <span className={`tree-icon ${node.kind}`} aria-hidden>
              {node.kind === "directory" ? (
                <Folder size={14} />
              ) : isTypstFile ? (
                <FileCode2 size={14} />
              ) : isImageFile ? (
                <FileImage size={14} />
              ) : isTextLikeFile ? (
                <FileText size={14} />
              ) : (
                <File size={14} />
              )}
            </span>
            <span className="tree-name">{node.name}</span>
          </span>
        </nve-button>
        {canManage && (
          <nve-icon-button
            className="mini"
            role="button"
            container="flat"
            size="sm"
            aria-label={t("workspace.actionsFor", { name: node.name })}
            onClick={(event) => {
              event.stopPropagation();
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              onRequestContextMenu({
                path: node.path,
                kind: node.kind,
                x: Math.round(rect.left),
                y: Math.round(rect.bottom + 4)
              });
            }}
          >
            <MoreVertical size={14} />
          </nve-icon-button>
        )}
      </div>
      {node.kind === "directory" && isExpanded && node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              activePath={activePath}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpen={onOpen}
              canManage={canManage}
              onRequestContextMenu={onRequestContextMenu}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}
