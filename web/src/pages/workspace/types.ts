import type { ReactNode } from "react";

export type ProjectNode = {
  path: string;
  kind: "file" | "directory";
};

export type DocumentIdentity = {
  id: string;
  pathRevision: number;
  collaborationRevision: number;
};

export type ProjectTreeNodeView = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: ProjectTreeNodeView[];
};

export type AssetMeta = {
  id?: string;
  contentRevision?: string;
  contentType: string;
  sizeBytes?: number;
  createdAt?: string;
};

export type ContextMenuState = {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
};

export type PathDialogState =
  | {
      mode: "create";
      kind: "file" | "directory";
      parentPath: string;
      value: string;
    }
  | {
      mode: "rename";
      path: string;
      value: string;
    }
  | {
      mode: "delete";
      path: string;
    };

export type WorkspaceLayoutPrefs = {
  filesWidth: number;
  auxiliaryWidth: number;
  editorRatio: number;
};

export type WorkspaceFeaturePanel = `feature:${string}`;

export type WorkspaceOptionalPanelDescriptor = {
  panel: WorkspaceFeaturePanel;
  label: string;
  icon: ReactNode;
  active: boolean;
};

export type WorkspaceAuxiliaryPanel =
  | "settings"
  | "revisions"
  | WorkspaceFeaturePanel;

export type WorkspacePanelView =
  | "editor"
  | "files"
  | "preview"
  | "settings"
  | "revisions"
  | WorkspaceFeaturePanel;

export type PreviewFitMode = "manual" | "page" | "width";
