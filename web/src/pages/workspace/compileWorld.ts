import type { LatexEngine } from "@/lib/api";
import type { ProjectType } from "@/lib/deploymentCapabilities";
import { isFontFile, normalizePath } from "@/pages/workspace/utils";

export type CompileWorldInput = {
  scope: string;
  projectType: ProjectType;
  entryFilePath: string;
  documents: Record<string, string>;
  assets: Record<string, string>;
  activeDocument?: {
    path: string;
    content: string;
  };
};

export type CompileDocument = Readonly<{
  path: string;
  content: string;
}>;

export type CompileAsset = Readonly<{
  path: string;
  contentBase64: string;
}>;

/** An immutable, compiler-facing projection of one Workspace source state. */
export type CompileWorld = Readonly<{
  scope: string;
  projectType: ProjectType;
  entryFilePath: string;
  documents: readonly CompileDocument[];
  assets: readonly CompileAsset[];
  source: (path: string) => string | undefined;
}>;

export type CompileTarget =
  | Readonly<{ kind: "typst"; emitPdf: boolean }>
  | Readonly<{ kind: "latex"; engine: LatexEngine }>;

type FontCacheEntry = {
  contentBase64: string;
  bytes: Uint8Array;
};

const fontDataByWorld = new WeakMap<CompileWorld, readonly Uint8Array[]>();

function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function projectDocuments(
  input: CompileWorldInput,
  previous: readonly CompileDocument[] = [],
) {
  const activePath = input.activeDocument
    ? normalizePath(input.activeDocument.path)
    : "";
  const previousByPath = new Map(
    previous.map((document) => [document.path, document]),
  );
  const documents = new Map<string, CompileDocument>();
  for (const [rawPath, storedContent] of Object.entries(input.documents)) {
    const path = normalizePath(rawPath);
    const content =
      path === activePath
        ? input.activeDocument?.content ?? storedContent
        : storedContent;
    const existing = previousByPath.get(path);
    documents.set(
      path,
      existing?.content === content
        ? existing
        : Object.freeze({ path, content }),
    );
  }
  return Object.freeze(
    Array.from(documents.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  );
}

function projectAssets(
  input: CompileWorldInput,
  previous: readonly CompileAsset[] = [],
) {
  const previousByPath = new Map(previous.map((asset) => [asset.path, asset]));
  const assets = new Map<string, CompileAsset>();
  for (const [rawPath, contentBase64] of Object.entries(input.assets)) {
    const path = normalizePath(rawPath);
    const existing = previousByPath.get(path);
    assets.set(
      path,
      existing?.contentBase64 === contentBase64
        ? existing
        : Object.freeze({ path, contentBase64 }),
    );
  }
  return Object.freeze(
    Array.from(assets.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  );
}

function sameDocuments(
  left: readonly CompileDocument[],
  right: readonly CompileDocument[],
) {
  return (
    left.length === right.length &&
    left.every(
      (document, index) =>
        document.path === right[index]?.path &&
        document.content === right[index]?.content,
    )
  );
}

function sameAssets(
  left: readonly CompileAsset[],
  right: readonly CompileAsset[],
) {
  return (
    left.length === right.length &&
    left.every(
      (asset, index) =>
        asset.path === right[index]?.path &&
        asset.contentBase64 === right[index]?.contentBase64,
    )
  );
}

function projectFonts(
  projectType: ProjectType,
  assets: readonly CompileAsset[],
  previous: ReadonlyMap<string, FontCacheEntry>,
) {
  if (projectType !== "typst") {
    return {
      fontCache: new Map<string, FontCacheEntry>(),
      fontData: Object.freeze([]) as readonly Uint8Array[],
    };
  }
  const fontCache = new Map<string, FontCacheEntry>();
  for (const asset of assets) {
    if (!isFontFile(asset.path)) continue;
    const cached = previous.get(asset.path);
    fontCache.set(
      asset.path,
      cached?.contentBase64 === asset.contentBase64
        ? cached
        : {
            contentBase64: asset.contentBase64,
            bytes: decodeBase64(asset.contentBase64),
          },
    );
  }
  return {
    fontCache,
    fontData: Object.freeze(
      Array.from(fontCache.values(), (font) => font.bytes),
    ),
  };
}

/**
 * Projects immutable Worlds while retaining only private structural/font caches.
 * Calling `project` during an abandoned React render cannot publish partial state:
 * the cache may advance, but every returned World remains a complete value.
 */
export class CompileWorldProjector {
  private previous: CompileWorld | null = null;
  private fontCache: ReadonlyMap<string, FontCacheEntry> = new Map();

  project(input: CompileWorldInput): CompileWorld {
    const documents = projectDocuments(input, this.previous?.documents);
    const assets = projectAssets(input, this.previous?.assets);
    const entryFilePath = normalizePath(input.entryFilePath);
    if (
      this.previous?.scope === input.scope &&
      this.previous.projectType === input.projectType &&
      this.previous.entryFilePath === entryFilePath &&
      sameDocuments(this.previous.documents, documents) &&
      sameAssets(this.previous.assets, assets)
    ) {
      return this.previous;
    }

    const { fontCache, fontData } = projectFonts(
      input.projectType,
      assets,
      this.fontCache,
    );
    const documentMap = new Map(
      documents.map((document) => [document.path, document.content]),
    );
    const world = Object.freeze({
      scope: input.scope,
      projectType: input.projectType,
      entryFilePath,
      documents,
      assets,
      source: (path: string) => documentMap.get(normalizePath(path)),
    });
    fontDataByWorld.set(world, fontData);
    this.previous = world;
    this.fontCache = fontCache;
    return world;
  }
}

/** Exposes cached font buffers only at the compiler adapter boundary. */
export function compileWorldFontData(world: CompileWorld) {
  return fontDataByWorld.get(world) ?? [];
}

export function createCompileTarget(
  projectType: ProjectType,
  latexEngine: LatexEngine,
  typstEmitPdf: boolean,
): CompileTarget {
  return projectType === "latex"
    ? Object.freeze({ kind: "latex", engine: latexEngine })
    : Object.freeze({ kind: "typst", emitPdf: typstEmitPdf });
}

export function sameCompileTarget(
  left: CompileTarget,
  right: CompileTarget,
) {
  return (
    left.kind === right.kind &&
    (left.kind === "latex"
      ? right.kind === "latex" && left.engine === right.engine
      : right.kind === "typst" && left.emitPdf === right.emitPdf)
  );
}

/** Compares compiler semantics while deliberately ignoring Typst PDF emission. */
export function sameCompilerTarget(
  left: CompileTarget,
  right: CompileTarget,
) {
  return (
    left.kind === right.kind &&
    (left.kind === "typst" ||
      (right.kind === "latex" && left.engine === right.engine))
  );
}
