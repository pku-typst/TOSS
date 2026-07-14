import {
  createProjectFile,
  getGitRepoLink,
  getProjectSettings,
  getProjectTree,
  listDocuments,
  listProjectAssets,
  listProjectShareLinks,
  type LatexEngine,
  type ProjectShareLink
} from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import {
  mapAssetMetaByPath,
  mapDocumentIdentitiesByPath,
  mapDocumentsByPath
} from "@/pages/workspace/mappers";
import type {
  AssetMeta,
  DocumentIdentity,
  ProjectNode
} from "@/pages/workspace/types";

type LoadedDocuments = {
  documents: Awaited<ReturnType<typeof listDocuments>>["documents"];
  changeSequence: number | null;
};

async function loadDocumentPages(
  projectId: string,
  afterChangeSequence: number | null = null
): Promise<LoadedDocuments> {
  const documents: LoadedDocuments["documents"] = [];
  let changeSequence = afterChangeSequence;
  while (true) {
    const page = await listDocuments(projectId, { afterChangeSequence: changeSequence });
    documents.push(...page.documents);
    const previousSequence = changeSequence;
    if (page.cursor !== null) changeSequence = page.cursor;
    if (!page.has_more) return { documents, changeSequence };
    if (changeSequence === previousSequence) {
      throw new Error("Document pagination cursor did not advance");
    }
  }
}

export function defaultEntryForProjectType(projectType: ProjectType): string {
  return projectType === "latex" ? "main.tex" : "main.typ";
}

type LoadWorkspaceBootstrapInput = {
  projectId: string;
  projectTypeHint: ProjectType;
  canWrite: boolean;
  canViewShareLinks: boolean;
};

export type WorkspaceBootstrap = {
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  settingsRevision: number;
  nodes: ProjectNode[];
  contentEpoch: number;
  gitRepoUrl: string;
  shareLinks: ProjectShareLink[];
  documents: Record<string, string>;
  documentIdentities: Record<string, DocumentIdentity>;
  documentsChangeSequence: number | null;
  assetMeta: Record<string, AssetMeta>;
};

export async function loadWorkspaceBootstrap(
  input: LoadWorkspaceBootstrapInput
): Promise<WorkspaceBootstrap> {
  const defaultEntryHint = defaultEntryForProjectType(input.projectTypeHint);
  const shareLinksPromise = input.canViewShareLinks
    ? listProjectShareLinks(input.projectId).catch(() => [])
    : Promise.resolve([]);
  let [tree, settings, git, documents, assets, shareLinks] =
    await Promise.all([
      getProjectTree(input.projectId),
      getProjectSettings(input.projectId).catch(() => ({
        project_type: input.projectTypeHint,
        latex_engine: null,
        entry_file_path: defaultEntryHint,
        settings_revision: -1
      })),
      getGitRepoLink(input.projectId).catch(() => ({ repo_url: "" })),
      loadDocumentPages(input.projectId),
      listProjectAssets(input.projectId).catch(() => ({ assets: [] })),
      shareLinksPromise
    ]);

  if (input.canWrite && !tree.nodes.some((node) => node.kind === "file")) {
    const initialEntry = defaultEntryForProjectType(settings.project_type);
    await createProjectFile(input.projectId, {
      path: initialEntry,
      kind: "file",
      content: ""
    }).catch(() => undefined);
    [tree, documents] = await Promise.all([
      getProjectTree(input.projectId),
      loadDocumentPages(input.projectId)
    ]);
  }

  const projectType = settings.project_type;
  const entryFilePath =
    settings.entry_file_path ||
    tree.entry_file_path ||
    defaultEntryForProjectType(projectType);

  return {
    projectType,
    latexEngine: settings.latex_engine ?? "xetex",
    entryFilePath,
    settingsRevision: settings.settings_revision,
    nodes: tree.nodes,
    contentEpoch: tree.content_epoch,
    gitRepoUrl: git.repo_url || "",
    shareLinks,
    documents: mapDocumentsByPath(documents.documents),
    documentIdentities: mapDocumentIdentitiesByPath(documents.documents),
    documentsChangeSequence: documents.changeSequence,
    assetMeta: mapAssetMetaByPath(assets.assets)
  };
}

type LoadWorkspaceDeltaInput = {
  projectId: string;
  projectType: ProjectType;
  latexEngine: LatexEngine;
  entryFilePath: string;
  afterDocumentsChangeSequence: number | null;
};

export type WorkspaceDelta = {
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

export async function loadWorkspaceDelta(
  input: LoadWorkspaceDeltaInput
): Promise<WorkspaceDelta> {
  const [tree, settings, documents, assets] = await Promise.all([
    getProjectTree(input.projectId),
    getProjectSettings(input.projectId),
    loadDocumentPages(input.projectId, input.afterDocumentsChangeSequence),
    listProjectAssets(input.projectId)
  ]);
  const projectType = settings.project_type;

  return {
    projectType,
    latexEngine: settings.latex_engine ?? "xetex",
    entryFilePath:
      settings.entry_file_path ||
      tree.entry_file_path ||
      input.entryFilePath ||
      defaultEntryForProjectType(projectType),
    settingsRevision: settings.settings_revision,
    nodes: tree.nodes,
    contentEpoch: tree.content_epoch,
    documents: mapDocumentsByPath(documents.documents),
    documentIdentities: mapDocumentIdentitiesByPath(documents.documents),
    documentsChangeSequence: documents.changeSequence,
    assetMeta: mapAssetMetaByPath(assets.assets)
  };
}
