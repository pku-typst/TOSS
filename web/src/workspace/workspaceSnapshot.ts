import type { LatexEngine } from "@/lib/api/types";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import type {
  AssetMeta,
  DocumentIdentity,
  ProjectNode,
} from "@/pages/workspace/types";

export type LoadWorkspaceBootstrapInput = {
  projectId: string;
  projectTypeHint: ProjectType;
  canWrite: boolean;
};

export type WorkspaceBootstrap = {
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  settingsRevision: number;
  nodes: ProjectNode[];
  contentEpoch: number;
  documents: Record<string, string>;
  documentIdentities: Record<string, DocumentIdentity>;
  documentsChangeSequence: number | null;
  assetMeta: Record<string, AssetMeta>;
};

export type LoadWorkspaceDeltaInput = {
  projectId: string;
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  afterDocumentsChangeSequence: number | null;
};

export type WorkspaceDelta = WorkspaceBootstrap;
