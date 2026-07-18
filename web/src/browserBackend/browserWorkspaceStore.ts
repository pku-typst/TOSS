import { createTarGzip } from "nanotar";
import * as Y from "yjs";
import {
  browserStores,
  deleteRecord,
  getAllByIndex,
  getAllRecords,
  getRecord,
  putRecord,
  withBrowserTransaction,
} from "@/browserBackend/browserDatabase";
import { BrowserWorkspaceEvents } from "@/browserBackend/browserEvents";
import {
  type BrowserProjectSeed,
  type StoredBrowserAsset,
  type StoredBrowserDocument,
  type StoredBrowserProject,
  type StoredBrowserThumbnail,
  toProject,
} from "@/browserBackend/browserRecords";
import type {
  CreateProjectFileInput,
  CreateProjectInput,
  Document,
  LatexEngine,
  Project,
  ProjectAsset,
  ProjectSettings,
  UpdateProjectEntryFileInput,
  UpdateProjectLatexEngineInput,
  UploadAssetInput,
  UploadProjectThumbnailInput,
} from "@/lib/api/types";
import { base64ToBytes } from "@/lib/base64";
import type {
  LoadWorkspaceBootstrapInput,
  LoadWorkspaceDeltaInput,
  WorkspaceBootstrap,
  WorkspaceDelta,
} from "@/workspace/workspaceSnapshot";

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function validPath(value: string) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = path.split("/");
  if (
    !path ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\u0000-\u001f\u007f]/u.test(part),
    )
  ) {
    throw new Error("project_path_invalid");
  }
  return parts.join("/");
}

function projectName(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("project_name_invalid");
  }
  return normalized;
}

function ancestors(path: string) {
  const parts = path.split("/");
  const output: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    output.push(parts.slice(0, index).join("/"));
  }
  return output;
}

function normalizedDirectories(
  explicit: Iterable<string>,
  paths: Iterable<string>,
) {
  const directories = new Set<string>();
  for (const directory of explicit) {
    const path = validPath(directory);
    directories.add(path);
    for (const parent of ancestors(path)) directories.add(parent);
  }
  for (const path of paths) {
    for (const parent of ancestors(path)) directories.add(parent);
  }
  return [...directories].sort();
}

function stateForText(content: string) {
  const document = new Y.Doc();
  if (content) document.getText("main").insert(0, content);
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  return ownBuffer(update);
}

function textForState(update: Uint8Array) {
  const document = new Y.Doc();
  Y.applyUpdate(document, update);
  const content = document.getText("main").toString();
  document.destroy();
  return content;
}

function toDocument(record: StoredBrowserDocument): Document {
  return {
    id: record.id,
    project_id: record.projectId,
    path: record.path,
    content: record.content,
    path_revision: record.pathRevision,
    collaboration_revision: record.collaborationRevision,
    change_sequence: record.changeSequence,
    updated_at: record.updatedAt,
  };
}

function settings(record: StoredBrowserProject): ProjectSettings {
  return {
    project_id: record.id,
    project_type: record.projectType,
    latex_engine: record.latexEngine,
    entry_file_path: record.entryFilePath,
    settings_revision: record.settingsRevision,
    updated_at: record.updatedAt,
  };
}

function workspaceChanged(
  scope: "tree" | "settings" | "assets",
) {
  return {
    scope,
    path: null,
    document_id: null,
    collaboration_revision: null,
    change_sequence: null,
  } as const;
}

function documentChanged(record: StoredBrowserDocument) {
  return {
    scope: "document",
    path: record.path,
    document_id: record.id,
    collaboration_revision: record.collaborationRevision,
    change_sequence: record.changeSequence,
  } as const;
}

function movePath(path: string, from: string, to: string) {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

function within(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}/`);
}

function validatePathNamespace(
  directories: Iterable<string>,
  files: Iterable<string>,
) {
  const directorySet = new Set(directories);
  const fileSet = new Set(files);
  for (const file of fileSet) {
    if (directorySet.has(file)) throw new Error("project_path_conflict");
    if (ancestors(file).some((parent) => fileSet.has(parent))) {
      throw new Error("project_path_conflict");
    }
  }
  for (const directory of directorySet) {
    if (ancestors(directory).some((parent) => fileSet.has(parent))) {
      throw new Error("project_path_conflict");
    }
  }
}

function seedFiles(seed: BrowserProjectSeed) {
  const files = [...seed.files];
  if (!files.some((file) => file.path === seed.entryFilePath)) {
    files.unshift({ path: seed.entryFilePath, content: "" });
  }
  return files;
}

export class BrowserWorkspaceStore {
  constructor(readonly events: BrowserWorkspaceEvents) {}

  async listProjects(query?: { includeArchived?: boolean; q?: string }) {
    const records = await withBrowserTransaction(
      browserStores.projects,
      "readonly",
      (transaction) =>
        getAllRecords<StoredBrowserProject>(
          transaction.objectStore(browserStores.projects),
        ),
    );
    const needle = query?.q?.trim().toLocaleLowerCase() ?? "";
    return records
      .filter((record) => query?.includeArchived || !record.archived)
      .filter((record) => !needle || record.name.toLocaleLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toProject);
  }

  async createProject(input: CreateProjectInput, seed: BrowserProjectSeed) {
    return this.createSeededProject(projectName(input.name), {
      ...seed,
      projectType: input.project_type ?? seed.projectType,
      latexEngine: input.latex_engine ?? seed.latexEngine,
    });
  }

  async createSeededProject(name: string, seed: BrowserProjectSeed) {
    const createdAt = now();
    const record: StoredBrowserProject = {
      id: id(),
      name: projectName(name),
      projectType: seed.projectType,
      latexEngine: seed.projectType === "latex" ? seed.latexEngine ?? "xetex" : null,
      entryFilePath: validPath(seed.entryFilePath),
      settingsRevision: 0,
      contentEpoch: 1,
      documentsChangeSequence: 0,
      directories: [],
      archived: false,
      archivedAt: null,
      isTemplate: false,
      hasThumbnail: false,
      createdAt,
      updatedAt: createdAt,
    };

    await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const documentsStore = transaction.objectStore(browserStores.documents);
        const assetsStore = transaction.objectStore(browserStores.assets);
        const paths = new Set<string>();
        const directories = new Set<string>();
        const normalizedFiles = seedFiles(seed).map((file) => ({
          ...file,
          path: validPath(file.path),
        }));
        validatePathNamespace([], normalizedFiles.map((file) => file.path));
        for (const file of normalizedFiles) {
          const path = validPath(file.path);
          if (paths.has(path)) throw new Error("project_path_conflict");
          paths.add(path);
          for (const parent of ancestors(path)) directories.add(parent);
          if ("content" in file) {
            record.documentsChangeSequence += 1;
            await putRecord<StoredBrowserDocument>(documentsStore, {
              id: id(),
              projectId: record.id,
              path,
              content: file.content,
              yUpdate: stateForText(file.content),
              pathRevision: 0,
              collaborationRevision: 0,
              changeSequence: record.documentsChangeSequence,
              updatedAt: createdAt,
            });
          } else {
            const bytes = base64ToBytes(file.contentBase64);
            await putRecord<StoredBrowserAsset>(assetsStore, {
              id: id(),
              project_id: record.id,
              path,
              content_revision: id(),
              content_type: file.contentType,
              size_bytes: bytes.byteLength,
              uploaded_by: null,
              created_at: createdAt,
              bytes: ownBuffer(bytes),
            });
          }
        }
        record.directories = [...directories].sort();
        await putRecord(
          transaction.objectStore(browserStores.projects),
          record,
        );
      },
    );
    return toProject(record);
  }

  async copyProject(sourceProjectId: string, name: string) {
    const createdAt = now();
    return withBrowserTransaction(
      [
        browserStores.projects,
        browserStores.documents,
        browserStores.assets,
        browserStores.thumbnails,
      ],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const source = await getRecord<StoredBrowserProject>(projects, sourceProjectId);
        if (!source) throw new Error("project_not_found");
        const documentsStore = transaction.objectStore(browserStores.documents);
        const assetsStore = transaction.objectStore(browserStores.assets);
        const [documents, assets, thumbnail] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documentsStore, "projectId", sourceProjectId),
          getAllByIndex<StoredBrowserAsset>(assetsStore, "projectId", sourceProjectId),
          getRecord<StoredBrowserThumbnail>(
            transaction.objectStore(browserStores.thumbnails),
            sourceProjectId,
          ),
        ]);
        const projectId = id();
        const copy: StoredBrowserProject = {
          ...source,
          id: projectId,
          name: projectName(name),
          archived: false,
          archivedAt: null,
          isTemplate: false,
          createdAt,
          updatedAt: createdAt,
        };
        await putRecord(projects, copy);
        for (const document of documents) {
          await putRecord(documentsStore, {
            ...document,
            id: id(),
            projectId,
            updatedAt: createdAt,
          } satisfies StoredBrowserDocument);
        }
        for (const asset of assets) {
          await putRecord(assetsStore, {
            ...asset,
            id: id(),
            project_id: projectId,
            content_revision: id(),
            created_at: createdAt,
          } satisfies StoredBrowserAsset);
        }
        if (thumbnail) {
          await putRecord(transaction.objectStore(browserStores.thumbnails), {
            ...thumbnail,
            projectId,
          } satisfies StoredBrowserThumbnail);
        }
        return toProject(copy);
      },
    );
  }

  async renameProject(projectId: string, name: string) {
    await this.updateProject(projectId, (project) => ({
      ...project,
      name: projectName(name),
      updatedAt: now(),
    }));
  }

  async setArchived(projectId: string, archived: boolean) {
    const updatedAt = now();
    await this.updateProject(projectId, (project) => ({
      ...project,
      archived,
      archivedAt: archived ? updatedAt : null,
      updatedAt,
    }));
  }

  async setTemplate(projectId: string, enabled: boolean) {
    await this.updateProject(projectId, (project) => ({
      ...project,
      isTemplate: enabled,
      updatedAt: now(),
    }));
  }

  private async updateProject(
    projectId: string,
    update: (project: StoredBrowserProject) => StoredBrowserProject,
  ) {
    return withBrowserTransaction(browserStores.projects, "readwrite", async (transaction) => {
      const store = transaction.objectStore(browserStores.projects);
      const project = await getRecord<StoredBrowserProject>(store, projectId);
      if (!project) throw new Error("project_not_found");
      const updated = update(project);
      await putRecord(store, updated);
      return updated;
    });
  }

  async loadThumbnail(projectId: string) {
    const thumbnail = await withBrowserTransaction(
      browserStores.thumbnails,
      "readonly",
      (transaction) =>
        getRecord<StoredBrowserThumbnail>(
          transaction.objectStore(browserStores.thumbnails),
          projectId,
        ),
    );
    return thumbnail
      ? new Blob([thumbnail.bytes], { type: thumbnail.contentType })
      : null;
  }

  async saveThumbnail(projectId: string, input: UploadProjectThumbnailInput) {
    const bytes = base64ToBytes(input.content_base64);
    await withBrowserTransaction(
      [browserStores.projects, browserStores.thumbnails],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        await putRecord(transaction.objectStore(browserStores.thumbnails), {
          projectId,
          contentType: input.content_type ?? "image/webp",
          bytes: ownBuffer(bytes),
        } satisfies StoredBrowserThumbnail);
        await putRecord(projects, {
          ...project,
          hasThumbnail: true,
          updatedAt: now(),
        } satisfies StoredBrowserProject);
      },
    );
  }

  async loadBootstrap(input: LoadWorkspaceBootstrapInput): Promise<WorkspaceBootstrap> {
    return this.loadWorkspace(input.projectId, null);
  }

  async loadDelta(input: LoadWorkspaceDeltaInput): Promise<WorkspaceDelta> {
    return this.loadWorkspace(
      input.projectId,
      input.afterDocumentsChangeSequence,
    );
  }

  private async loadWorkspace(projectId: string, afterSequence: number | null) {
    return withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readonly",
      async (transaction): Promise<WorkspaceBootstrap> => {
        const project = await getRecord<StoredBrowserProject>(
          transaction.objectStore(browserStores.projects),
          projectId,
        );
        if (!project) throw new Error("project_not_found");
        const [allDocuments, assets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(
            transaction.objectStore(browserStores.documents),
            "projectId",
            projectId,
          ),
          getAllByIndex<StoredBrowserAsset>(
            transaction.objectStore(browserStores.assets),
            "projectId",
            projectId,
          ),
        ]);
        const documents =
          afterSequence === null
            ? allDocuments
            : allDocuments.filter((document) => document.changeSequence > afterSequence);
        const nodes = [
          ...project.directories.map((path) => ({ path, kind: "directory" as const })),
          ...allDocuments.map((document) => ({ path: document.path, kind: "file" as const })),
          ...assets.map((asset) => ({ path: asset.path, kind: "file" as const })),
        ].sort((left, right) => left.path.localeCompare(right.path));
        return {
          projectType: project.projectType,
          latexEngine: project.latexEngine ?? "xetex",
          entryFilePath: project.entryFilePath,
          settingsRevision: project.settingsRevision,
          nodes,
          contentEpoch: project.contentEpoch,
          documents: Object.fromEntries(
            documents.map((document) => [document.path, document.content]),
          ),
          documentIdentities: Object.fromEntries(
            documents.map((document) => [
              document.path,
              {
                id: document.id,
                pathRevision: document.pathRevision,
                collaborationRevision: document.collaborationRevision,
              },
            ]),
          ),
          documentsChangeSequence: project.documentsChangeSequence,
          assetMeta: Object.fromEntries(
            assets.map((asset) => [
              asset.path,
              {
                id: asset.id,
                contentRevision: asset.content_revision,
                contentType: asset.content_type,
                sizeBytes: asset.size_bytes,
                createdAt: asset.created_at,
              },
            ]),
          ),
        };
      },
    );
  }

  async createFile(projectId: string, input: CreateProjectFileInput) {
    const path = validPath(input.path);
    await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documents = transaction.objectStore(browserStores.documents);
        const assets = transaction.objectStore(browserStores.assets);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        const [allDocuments, allAssets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documents, "projectId", projectId),
          getAllByIndex<StoredBrowserAsset>(assets, "projectId", projectId),
        ]);
        const nextDirectories = normalizedDirectories(
          input.kind === "directory"
            ? [...project.directories, path]
            : project.directories,
          input.kind === "file" ? [path] : [],
        );
        const nextFilePaths = [
          ...allDocuments.map((document) => document.path),
          ...allAssets.map((asset) => asset.path),
          ...(input.kind === "file" ? [path] : []),
        ];
        if (
          allDocuments.some((document) => document.path === path) ||
          allAssets.some((asset) => asset.path === path) ||
          project.directories.includes(path)
        ) {
          throw new Error("project_path_conflict");
        }
        validatePathNamespace(nextDirectories, nextFilePaths);
        const updatedAt = now();
        const nextProject = {
          ...project,
          directories: nextDirectories,
          contentEpoch: project.contentEpoch + 1,
          updatedAt,
        } satisfies StoredBrowserProject;
        if (input.kind === "file") {
          nextProject.documentsChangeSequence += 1;
          const content = input.content ?? "";
          const changedDocument: StoredBrowserDocument = {
            id: id(),
            projectId,
            path,
            content,
            yUpdate: stateForText(content),
            pathRevision: 0,
            collaborationRevision: 0,
            changeSequence: nextProject.documentsChangeSequence,
            updatedAt,
          };
          await putRecord(documents, changedDocument);
        }
        await putRecord(projects, nextProject);
      },
    );
    this.events.publish(projectId, workspaceChanged("tree"));
  }

  async movePath(projectId: string, input: { from_path: string; to_path: string }) {
    const from = validPath(input.from_path);
    const to = validPath(input.to_path);
    if (from === to) return;
    await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documentsStore = transaction.objectStore(browserStores.documents);
        const assetsStore = transaction.objectStore(browserStores.assets);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        const [documents, assets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documentsStore, "projectId", projectId),
          getAllByIndex<StoredBrowserAsset>(assetsStore, "projectId", projectId),
        ]);
        const sourceExists =
          project.directories.some((path) => within(path, from)) ||
          documents.some((document) => within(document.path, from)) ||
          assets.some((asset) => within(asset.path, from));
        if (!sourceExists) throw new Error("not_found");
        if (within(to, from)) throw new Error("project_path_invalid");
        const externalPaths = new Set([
          ...project.directories.filter((path) => !within(path, from)),
          ...documents.filter((document) => !within(document.path, from)).map((document) => document.path),
          ...assets.filter((asset) => !within(asset.path, from)).map((asset) => asset.path),
        ]);
        const movedPaths = [
          ...project.directories.filter((path) => within(path, from)),
          ...documents.filter((document) => within(document.path, from)).map((document) => document.path),
          ...assets.filter((asset) => within(asset.path, from)).map((asset) => asset.path),
        ].map((path) => movePath(path, from, to));
        if (movedPaths.some((path) => externalPaths.has(path))) {
          throw new Error("project_path_conflict");
        }
        const nextDirectories = normalizedDirectories(
          project.directories.map((path) =>
            within(path, from) ? movePath(path, from, to) : path,
          ),
          movedPaths,
        );
        const nextFilePaths = [
          ...documents.map((document) =>
            within(document.path, from) ? movePath(document.path, from, to) : document.path,
          ),
          ...assets.map((asset) =>
            within(asset.path, from) ? movePath(asset.path, from, to) : asset.path,
          ),
        ];
        validatePathNamespace(nextDirectories, nextFilePaths);
        let sequence = project.documentsChangeSequence;
        const updatedAt = now();
        for (const document of documents) {
          if (!within(document.path, from)) continue;
          sequence += 1;
          const moved = {
            ...document,
            path: movePath(document.path, from, to),
            pathRevision: document.pathRevision + 1,
            changeSequence: sequence,
            updatedAt,
          };
          await putRecord(documentsStore, moved);
        }
        for (const asset of assets) {
          if (!within(asset.path, from)) continue;
          await putRecord(assetsStore, {
            ...asset,
            path: movePath(asset.path, from, to),
          } satisfies StoredBrowserAsset);
        }
        await putRecord(projects, {
          ...project,
          entryFilePath: within(project.entryFilePath, from)
            ? movePath(project.entryFilePath, from, to)
            : project.entryFilePath,
          settingsRevision: within(project.entryFilePath, from)
            ? project.settingsRevision + 1
            : project.settingsRevision,
          documentsChangeSequence: sequence,
          directories: nextDirectories,
          contentEpoch: project.contentEpoch + 1,
          updatedAt,
        } satisfies StoredBrowserProject);
      },
    );
    this.events.publish(projectId, workspaceChanged("tree"));
  }

  async deletePath(projectId: string, value: string) {
    const path = validPath(value);
    await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documentsStore = transaction.objectStore(browserStores.documents);
        const assetsStore = transaction.objectStore(browserStores.assets);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        const [documents, assets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documentsStore, "projectId", projectId),
          getAllByIndex<StoredBrowserAsset>(assetsStore, "projectId", projectId),
        ]);
        const removedDocuments = documents.filter((document) => within(document.path, path));
        const removedAssets = assets.filter((asset) => within(asset.path, path));
        const removedDirectory = project.directories.some((directory) => within(directory, path));
        if (removedDocuments.length === 0 && removedAssets.length === 0 && !removedDirectory) {
          throw new Error("not_found");
        }
        for (const document of removedDocuments) await deleteRecord(documentsStore, document.id);
        for (const asset of removedAssets) await deleteRecord(assetsStore, asset.id);
        const remainingPaths = [
          ...documents.filter((document) => !within(document.path, path)).map((document) => document.path),
          ...assets.filter((asset) => !within(asset.path, path)).map((asset) => asset.path),
        ];
        const entryRemoved = within(project.entryFilePath, path);
        await putRecord(projects, {
          ...project,
          entryFilePath: entryRemoved
            ? documents
                .filter((document) => !within(document.path, path))
                .map((document) => document.path)
                .find((candidate) => /\.(?:typ|tex)$/i.test(candidate)) ?? project.entryFilePath
            : project.entryFilePath,
          settingsRevision: entryRemoved ? project.settingsRevision + 1 : project.settingsRevision,
          directories: normalizedDirectories(
            project.directories.filter((directory) => !within(directory, path)),
            remainingPaths,
          ),
          contentEpoch: project.contentEpoch + 1,
          updatedAt: now(),
        } satisfies StoredBrowserProject);
      },
    );
    this.events.publish(projectId, workspaceChanged("tree"));
  }

  async upsertText(
    projectId: string,
    value: string,
    content: string,
    expectedContentEpoch?: number,
  ) {
    const path = validPath(value);
    const changed = await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documents = transaction.objectStore(browserStores.documents);
        const assets = transaction.objectStore(browserStores.assets);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        if (
          expectedContentEpoch !== undefined &&
          expectedContentEpoch !== project.contentEpoch
        ) {
          throw new Error("project_content_changed");
        }
        const [existing, replacedAsset] = await Promise.all([
          getRecord<StoredBrowserDocument>(documents.index("projectPath"), [projectId, path]),
          getRecord<StoredBrowserAsset>(assets.index("projectPath"), [projectId, path]),
        ]);
        if (project.directories.includes(path)) throw new Error("project_path_conflict");
        const [allDocuments, allAssets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documents, "projectId", projectId),
          getAllByIndex<StoredBrowserAsset>(assets, "projectId", projectId),
        ]);
        const nextFilePaths = [
          ...allDocuments.filter((document) => document.id !== existing?.id).map((document) => document.path),
          ...allAssets.filter((asset) => asset.id !== replacedAsset?.id).map((asset) => asset.path),
          path,
        ];
        const nextDirectories = normalizedDirectories(project.directories, [path]);
        validatePathNamespace(nextDirectories, nextFilePaths);
        if (replacedAsset) await deleteRecord(assets, replacedAsset.id);
        const updatedAt = now();
        const changeSequence = project.documentsChangeSequence + 1;
        const changed: StoredBrowserDocument = {
          id: existing?.id ?? id(),
          projectId,
          path,
          content,
          yUpdate: stateForText(content),
          pathRevision: existing?.pathRevision ?? 0,
          collaborationRevision: (existing?.collaborationRevision ?? -1) + 1,
          changeSequence,
          updatedAt,
        };
        await putRecord(documents, changed);
        await putRecord(projects, {
          ...project,
          directories: nextDirectories,
          contentEpoch: existing && !replacedAsset ? project.contentEpoch : project.contentEpoch + 1,
          documentsChangeSequence: changeSequence,
          updatedAt,
        } satisfies StoredBrowserProject);
        return {
          document: changed,
          structural: !existing || !!replacedAsset,
        };
      },
    );
    this.events.publish(
      projectId,
      changed.structural
        ? workspaceChanged("tree")
        : documentChanged(changed.document),
    );
    return toDocument(changed.document);
  }

  async uploadAsset(projectId: string, input: UploadAssetInput) {
    const path = validPath(input.path);
    const bytes = base64ToBytes(input.content_base64);
    const output = await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documents = transaction.objectStore(browserStores.documents);
        const assets = transaction.objectStore(browserStores.assets);
        const project = await getRecord<StoredBrowserProject>(projects, projectId);
        if (!project) throw new Error("project_not_found");
        const [replacedDocument, existing] = await Promise.all([
          getRecord<StoredBrowserDocument>(documents.index("projectPath"), [projectId, path]),
          getRecord<StoredBrowserAsset>(assets.index("projectPath"), [projectId, path]),
        ]);
        if (project.directories.includes(path)) throw new Error("project_path_conflict");
        const [allDocuments, allAssets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(documents, "projectId", projectId),
          getAllByIndex<StoredBrowserAsset>(assets, "projectId", projectId),
        ]);
        const nextFilePaths = [
          ...allDocuments.filter((document) => document.id !== replacedDocument?.id).map((document) => document.path),
          ...allAssets.filter((asset) => asset.id !== existing?.id).map((asset) => asset.path),
          path,
        ];
        const nextDirectories = normalizedDirectories(project.directories, [path]);
        validatePathNamespace(nextDirectories, nextFilePaths);
        if (replacedDocument) await deleteRecord(documents, replacedDocument.id);
        const createdAt = now();
        const asset: StoredBrowserAsset = {
          id: existing?.id ?? id(),
          project_id: projectId,
          path,
          content_revision: id(),
          content_type: input.content_type ?? "application/octet-stream",
          size_bytes: bytes.byteLength,
          uploaded_by: null,
          created_at: createdAt,
          bytes: ownBuffer(bytes),
        };
        await putRecord(assets, asset);
        await putRecord(projects, {
          ...project,
          directories: nextDirectories,
          contentEpoch: existing && !replacedDocument ? project.contentEpoch : project.contentEpoch + 1,
          updatedAt: createdAt,
        } satisfies StoredBrowserProject);
        const { bytes: _bytes, ...projectAsset } = asset;
        return projectAsset;
      },
    );
    this.events.publish(projectId, workspaceChanged("assets"));
    return output;
  }

  async readAsset(projectId: string, assetId: string) {
    const asset = await withBrowserTransaction(
      browserStores.assets,
      "readonly",
      (transaction) =>
        getRecord<StoredBrowserAsset>(
          transaction.objectStore(browserStores.assets),
          assetId,
        ),
    );
    if (!asset || asset.project_id !== projectId) throw new Error("project_asset_not_found");
    return new Uint8Array(asset.bytes.slice(0));
  }

  async updateEntryFile(projectId: string, input: UpdateProjectEntryFileInput) {
    const entryFilePath = validPath(input.entry_file_path);
    const updated = await this.updateProject(projectId, (project) => {
      const next = {
        ...project,
        entryFilePath,
        settingsRevision: project.settingsRevision + 1,
        updatedAt: now(),
      };
      return next;
    });
    this.events.publish(projectId, workspaceChanged("settings"));
    return settings(updated);
  }

  async updateLatexEngine(
    projectId: string,
    input: UpdateProjectLatexEngineInput,
  ) {
    const updated = await this.updateProject(projectId, (project) => {
      const next = {
        ...project,
        latexEngine: input.latex_engine as LatexEngine,
        settingsRevision: project.settingsRevision + 1,
        updatedAt: now(),
      };
      return next;
    });
    this.events.publish(projectId, workspaceChanged("settings"));
    return settings(updated);
  }

  async downloadArchive(projectId: string) {
    const files = await withBrowserTransaction(
      [browserStores.projects, browserStores.documents, browserStores.assets],
      "readonly",
      async (transaction) => {
        const project = await getRecord<StoredBrowserProject>(
          transaction.objectStore(browserStores.projects),
          projectId,
        );
        if (!project) throw new Error("project_not_found");
        const [documents, assets] = await Promise.all([
          getAllByIndex<StoredBrowserDocument>(
            transaction.objectStore(browserStores.documents),
            "projectId",
            projectId,
          ),
          getAllByIndex<StoredBrowserAsset>(
            transaction.objectStore(browserStores.assets),
            "projectId",
            projectId,
          ),
        ]);
        return [
          ...documents.map((document) => ({ name: document.path, data: document.content })),
          ...assets.map((asset) => ({ name: asset.path, data: new Uint8Array(asset.bytes) })),
        ];
      },
    );
    const bytes = await createTarGzip(files);
    return new Blob([new Uint8Array(bytes)], { type: "application/gzip" });
  }

  async loadDocumentState(projectId: string, documentId: string) {
    const document = await withBrowserTransaction(
      browserStores.documents,
      "readonly",
      (transaction) =>
        getRecord<StoredBrowserDocument>(
          transaction.objectStore(browserStores.documents),
          documentId,
        ),
    );
    if (!document || document.projectId !== projectId) {
      throw new Error("project_document_not_found");
    }
    return {
      update: new Uint8Array(document.yUpdate.slice(0)),
      document,
    };
  }

  async mergeDocumentUpdate(
    projectId: string,
    documentId: string,
    update: Uint8Array,
  ): Promise<StoredBrowserDocument> {
    const changed = await withBrowserTransaction(
      [browserStores.projects, browserStores.documents],
      "readwrite",
      async (transaction) => {
        const projects = transaction.objectStore(browserStores.projects);
        const documents = transaction.objectStore(browserStores.documents);
        const [project, document] = await Promise.all([
          getRecord<StoredBrowserProject>(projects, projectId),
          getRecord<StoredBrowserDocument>(documents, documentId),
        ]);
        if (!project) throw new Error("project_not_found");
        if (!document || document.projectId !== projectId) {
          throw new Error("project_document_not_found");
        }
        const merged = Y.mergeUpdates([new Uint8Array(document.yUpdate), update]);
        const updatedAt = now();
        const changed: StoredBrowserDocument = {
          ...document,
          content: textForState(merged),
          yUpdate: ownBuffer(merged),
          changeSequence: project.documentsChangeSequence + 1,
          updatedAt,
        };
        await putRecord(documents, changed);
        await putRecord(projects, {
          ...project,
          documentsChangeSequence: changed.changeSequence,
          updatedAt,
        } satisfies StoredBrowserProject);
        return changed;
      },
    );
    this.events.publish(projectId, documentChanged(changed));
    return changed;
  }
}
