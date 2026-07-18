import { TypstSnippet } from "@myriaddreamin/typst.ts/contrib/snippet";
import {
  CompileFormatEnum,
  type IncrementalServer,
  type TypstCompiler
} from "@myriaddreamin/typst.ts/compiler";
import { FetchAccessModel } from "@myriaddreamin/typst.ts/fs/fetch";
import {
  withAccessModel,
  withPackageRegistry
} from "@myriaddreamin/typst.ts/options.init";
import {
  loadBuiltinTypst,
  type BuiltinFontProfile,
  type LoadedBuiltinTypst
} from "@/lib/typstBuiltin";
import { createHybridPackageRegistry } from "@/lib/typstUniverse";
import {
  absoluteRuntimeModuleUrl,
  loadTypstRuntimeManifest,
  TYPST_RUNTIME_MODULE_CACHE,
  type TypstRuntimeModule,
  verifyRuntimeModule
} from "@/lib/typstRuntime";
import {
  incrementalMappingRevision,
  mapDocumentToSource,
  mapSourceToDocument,
  type TypstMappingRequest,
  type TypstMappingResponse
} from "@/lib/typstSync";
import { loadBrowserFonts } from "@/lib/typstFontLoader";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";

type CompileRequest = {
  kind: "compile";
  id: number;
  entryFilePath: string;
  workspaceKey: string;
  resetWorkspace: boolean;
  documentUpserts: Array<{ path: string; content: string }>;
  documentDeletes: string[];
  assetUpserts: Array<{ path: string; content_base64: string }>;
  assetDeletes: string[];
  environment: CompilationEnvironment["typst"];
  fontData?: Uint8Array[];
  fontSignature?: string;
  emitPdf?: boolean;
  pdfOnly?: boolean;
  diagnosticsOnly?: boolean;
  forceFullVector?: boolean;
};

type PrewarmRequest = {
  kind: "prewarm";
  id: number;
  environment: CompilationEnvironment["typst"];
  fontProfile: BuiltinFontProfile;
};

type CompileQueueRequest = CompileRequest | PrewarmRequest;
type WorkerRequest = CompileQueueRequest | TypstMappingRequest;

type CompileResponse = {
  id: number;
  ok: boolean;
  workspaceApplied?: boolean;
  vectorBytes?: Uint8Array;
  vectorMode?: "full" | "delta";
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
  mappingRevision?: number;
};

type RuntimeStatusMessage = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "downloading-package" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
  package_spec?: string;
};

type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  line?: number;
  column?: number;
  raw: string;
};

class NormalizedFetchAccessModel extends FetchAccessModel {
  resolvePath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return super.resolvePath(normalized);
  }
}

let typstPromise: Promise<TypstSnippet> | null = null;
let accessModel: NormalizedFetchAccessModel | null = null;
let configKey = "";
let compileCount = 0;
let builtinPromise: Promise<LoadedBuiltinTypst> | null = null;
let builtinKey = "";
const shadowFiles = new Map<string, { kind: "source" | "asset"; value: string }>();
const workspaceDocuments = new Map<string, string>();
const workspaceAssets = new Map<string, string>();
let activeWorkspaceKey = "";
let workspaceFontData: Uint8Array[] = [];
let workspaceFontSignature = "";
let workspaceFontProfile: BuiltinFontProfile = "latin";
type IncrementalCompilerSession = {
  compiler: TypstCompiler;
  server: IncrementalServer;
  release: () => void;
  task: Promise<void>;
};
let incrementalCompilerSession: IncrementalCompilerSession | null = null;
let incrementalCompilerSessionPromise: Promise<IncrementalCompilerSession> | null = null;
let incrementalServerHasState = false;

async function disposeIncrementalCompilerSession() {
  const session = incrementalCompilerSession;
  incrementalCompilerSession = null;
  incrementalCompilerSessionPromise = null;
  incrementalServerHasState = false;
  if (!session) return;
  session.release();
  await session.task.catch(() => undefined);
}

async function resetCompilerState() {
  await disposeIncrementalCompilerSession();
  typstPromise = null;
  accessModel = null;
  configKey = "";
  compileCount = 0;
  shadowFiles.clear();
}

async function createIncrementalCompilerSession(compiler: TypstCompiler) {
  let release: () => void = () => undefined;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveReady!: (server: IncrementalServer) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<IncrementalServer>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const task = compiler.withIncrementalServer(async (server) => {
    resolveReady(server);
    await lifetime;
  });
  void task.catch(rejectReady);
  const server = await ready;
  return { compiler, server, release, task } satisfies IncrementalCompilerSession;
}

async function getIncrementalCompilerSession(compiler: TypstCompiler) {
  if (incrementalCompilerSession?.compiler === compiler) return incrementalCompilerSession;
  if (incrementalCompilerSessionPromise) return incrementalCompilerSessionPromise;
  await disposeIncrementalCompilerSession();
  incrementalCompilerSessionPromise = createIncrementalCompilerSession(compiler);
  try {
    incrementalCompilerSession = await incrementalCompilerSessionPromise;
    incrementalServerHasState = false;
    return incrementalCompilerSession;
  } finally {
    incrementalCompilerSessionPromise = null;
  }
}

function normalizeWorkspacePath(path: string) {
  const clean = path.trim().replace(/^\/+/, "");
  if (!clean) return "main.typ";
  return clean;
}

function sourcePath(path: string) {
  return `/${normalizeWorkspacePath(path)}`;
}

function parseCompileDiagnostic(rawLine: string): CompileDiagnostic {
  const raw = rawLine.trim();
  const pattern =
    /^(?<path>.+?):(?<line>\d+):(?<column>\d+)(?::\d+:\d+)?:\s*(?<severity>error|warning|info):\s*(?<message>.+)$/i;
  const matched = raw.match(pattern);
  if (!matched?.groups) {
    return {
      severity: "error",
      message: raw,
      raw
    };
  }
  const path = matched.groups.path.replace(/^\/+/, "");
  const line = Number.parseInt(matched.groups.line, 10);
  const column = Number.parseInt(matched.groups.column, 10);
  const severityRaw = matched.groups.severity.toLowerCase();
  const severity: "error" | "warning" | "info" =
    severityRaw === "warning" ? "warning" : severityRaw === "info" ? "info" : "error";
  return {
    severity,
    path: path || undefined,
    line: Number.isFinite(line) ? line : undefined,
    column: Number.isFinite(column) ? column : undefined,
    message: matched.groups.message.trim(),
    raw
  };
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function readCachedArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(TYPST_RUNTIME_MODULE_CACHE);
    const cached = await cache.match(url);
    if (!cached) return null;
    return cached.arrayBuffer();
  } catch {
    return null;
  }
}

async function writeCachedArrayBuffer(url: string, bytes: Uint8Array, label: string) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(TYPST_RUNTIME_MODULE_CACHE);
    await cache.put(
      url,
      new Response(new Blob([new Uint8Array(bytes).buffer]), {
        headers: {
          "content-type": "application/wasm",
          "x-runtime-module": label,
          "cache-control": "public, max-age=31536000, immutable"
        }
      })
    );
  } catch {
    // best effort only
  }
}

async function deleteCachedArrayBuffer(url: string) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(TYPST_RUNTIME_MODULE_CACHE);
    await cache.delete(url);
  } catch {
    // best effort only
  }
}

async function fetchArrayBufferWithContext(url: string, label: string, module: TypstRuntimeModule) {
  const cached = await readCachedArrayBuffer(url);
  if (cached) {
    try {
      await verifyRuntimeModule(cached, module, label);
      self.postMessage({
        kind: "runtime.status",
        stage: "downloading-compiler",
        loaded_bytes: cached.byteLength,
        total_bytes: cached.byteLength
      } satisfies RuntimeStatusMessage);
      return cached;
    } catch {
      await deleteCachedArrayBuffer(url);
    }
  }
  let response: Response;
  try {
    response = await fetch(url, { cache: "force-cache" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    throw new Error(`${label} fetch failed at ${url}: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`${label} fetch failed at ${url}: status ${response.status}`);
  }
  // Fetch exposes a decoded response body while Content-Length can describe the
  // compressed transfer. The versioned runtime manifest records the decoded size,
  // so it is the authoritative denominator for download progress as well as
  // the integrity check below.
  const totalBytes = module.size_bytes;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    await verifyRuntimeModule(buffer, module, label);
    await writeCachedArrayBuffer(url, new Uint8Array(buffer), label);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    chunks.push(value);
    loadedBytes += value.length;
    self.postMessage({
      kind: "runtime.status",
      stage: "downloading-compiler",
      loaded_bytes: loadedBytes,
      total_bytes: totalBytes
    } satisfies RuntimeStatusMessage);
  }
  const merged = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  await verifyRuntimeModule(merged, module, label);
  await writeCachedArrayBuffer(url, merged, label);
  return merged.buffer;
}

async function getBuiltinTypst(
  environment: CompilationEnvironment["typst"],
) {
  const nextKey = `${environment.builtinBaseUrl}:${environment.builtinCredentials}`;
  if (!builtinPromise || builtinKey !== nextKey) {
    builtinKey = nextKey;
    builtinPromise = loadBuiltinTypst({
      baseUrl: environment.builtinBaseUrl,
      credentials: environment.builtinCredentials,
    }).catch((error) => {
      builtinPromise = null;
      throw error;
    });
  }
  return builtinPromise;
}

async function getTypst(
  environment: CompilationEnvironment["typst"],
  fontData: Uint8Array[],
  fontSignature: string,
  fontProfile: BuiltinFontProfile,
) {
  const [builtin, runtimeManifest] = await Promise.all([
    getBuiltinTypst(environment),
    loadTypstRuntimeManifest(environment.runtimeBaseUrl),
  ]);
  const nextKey = JSON.stringify({
    environment,
    runtimeVersion: runtimeManifest.typst_ts_version,
    builtin: builtin.cacheKey,
    fontProfile,
    fontSignature,
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!typstPromise || !accessModel || configKey !== nextKey) {
    if (incrementalCompilerSession) {
      await disposeIncrementalCompilerSession();
    }
    configKey = nextKey;
    compileCount = 0;
    shadowFiles.clear();
    accessModel = new NormalizedFetchAccessModel(environment.builtinBaseUrl, {
      fullyCached: true,
    });
    typstPromise = (async () => {
      const typst = new TypstSnippet();
      const packageRegistry = createHybridPackageRegistry({
        local: builtin.createLocalPackageRegistry(accessModel!),
        accessModel: accessModel!,
        source: environment.packageSource,
        onStatus: ({ phase, packageSpec }) => {
          self.postMessage({
            kind: "runtime.status",
            stage: phase === "downloading" ? "downloading-package" : "compiling",
            package_spec: packageSpec
          } satisfies RuntimeStatusMessage);
        }
      });
      typst.setCompilerInitOptions({
        beforeBuild: [
          withAccessModel(accessModel!),
          withPackageRegistry(packageRegistry),
          // Align browser preview with Typst CLI defaults by loading Typst's
          // builtin "text" font asset set (Libertinus/NewCM/DejaVu Mono),
          // then layer the versioned NV font bundle and project fonts on top.
          loadBrowserFonts([...builtin.fontUrlsForProfile(fontProfile), ...fontData], {
            assets: ["text"],
            assetUrlPrefix: environment.fontAssetsBaseUrl,
            fetcher: builtin.fontFetcher
          })
        ],
        getWrapper: () => import("@pku-typst/typst-ts-web-compiler"),
        getModule: () => {
          self.postMessage({
            kind: "runtime.status",
            stage: "downloading-compiler"
          } satisfies RuntimeStatusMessage);
          return {
            // typst.ts rc3 forwards this value to wasm-bindgen, whose current
            // initialization API requires the module promise inside an options object.
            module_or_path: (async () => {
              const compilerUrl = absoluteRuntimeModuleUrl(
                runtimeManifest.compiler,
                environment.runtimeBaseUrl,
              );
              const buffer = await fetchArrayBufferWithContext(
                compilerUrl,
                "compiler wasm",
                runtimeManifest.compiler
              );
              self.postMessage({
                kind: "runtime.status",
                stage: "ready"
              } satisfies RuntimeStatusMessage);
              return buffer;
            })()
          };
        }
      });
      return typst;
    })();
  }
  return typstPromise;
}

async function syncShadowFiles(
  typst: TypstSnippet,
  documents: Array<{ path: string; content: string }>,
  assets: Array<{ path: string; content_base64: string }>
) {
  const nextPaths = new Set<string>();
  for (const document of documents) {
    nextPaths.add(sourcePath(document.path));
    nextPaths.add(normalizeWorkspacePath(document.path));
  }
  for (const asset of assets) {
    nextPaths.add(sourcePath(asset.path));
    nextPaths.add(normalizeWorkspacePath(asset.path));
  }

  for (const path of Array.from(shadowFiles.keys())) {
    if (nextPaths.has(path)) continue;
    await typst.unmapShadow(path);
    shadowFiles.delete(path);
  }

  for (const document of documents) {
    const paths = [sourcePath(document.path), normalizeWorkspacePath(document.path)];
    for (const path of paths) {
      const previous = shadowFiles.get(path);
      if (previous?.kind === "source" && previous.value === document.content) continue;
      await typst.addSource(path, document.content);
      shadowFiles.set(path, { kind: "source", value: document.content });
    }
  }

  for (const asset of assets) {
    const paths = [sourcePath(asset.path), normalizeWorkspacePath(asset.path)];
    let bytes: Uint8Array | null = null;
    for (const path of paths) {
      const previous = shadowFiles.get(path);
      if (previous?.kind === "asset" && previous.value === asset.content_base64) continue;
      bytes ??= base64ToUint8(asset.content_base64);
      await typst.mapShadow(path, bytes);
      shadowFiles.set(path, { kind: "asset", value: asset.content_base64 });
    }
  }
}

const CJK_TEXT_PATTERN =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

function applyWorkspacePatch(request: CompileRequest) {
  const resetWorkspace = request.resetWorkspace || activeWorkspaceKey !== request.workspaceKey;
  if (resetWorkspace) {
    activeWorkspaceKey = request.workspaceKey;
    workspaceDocuments.clear();
    workspaceAssets.clear();
    workspaceFontData = [];
    workspaceFontSignature = "";
    workspaceFontProfile = "latin";
  }

  for (const path of request.documentDeletes) workspaceDocuments.delete(path);
  for (const document of request.documentUpserts) {
    workspaceDocuments.set(document.path, document.content);
  }
  for (const path of request.assetDeletes) workspaceAssets.delete(path);
  for (const asset of request.assetUpserts) {
    workspaceAssets.set(asset.path, asset.content_base64);
  }
  if (request.fontData) {
    workspaceFontData = request.fontData;
    workspaceFontSignature = request.fontSignature ?? "";
  } else if (resetWorkspace) {
    throw new Error("Workspace reset did not include its custom font snapshot");
  }
  if (
    workspaceFontProfile === "latin" &&
    Array.from(workspaceDocuments.values()).some((content) => CJK_TEXT_PATTERN.test(content))
  ) {
    workspaceFontProfile = "cjk";
  }

  return {
    documents: Array.from(workspaceDocuments, ([path, content]) => ({ path, content })),
    assets: Array.from(workspaceAssets, ([path, content_base64]) => ({ path, content_base64 }))
  };
}

let compileRunning = false;
let queuedRequest: CompileQueueRequest | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (
    event.data.kind === "mapping.source-to-document" ||
    event.data.kind === "mapping.document-to-source"
  ) {
    handleMappingRequest(event.data);
    return;
  }
  if (queuedRequest) {
    self.postMessage({
      id: queuedRequest.id,
      ok: false,
      workspaceApplied: false,
      errors: ["Typst request superseded by a newer edit"]
    } satisfies CompileResponse);
  }
  queuedRequest = event.data;
  void drainCompileQueue();
};

function handleMappingRequest(request: TypstMappingRequest) {
  const session = incrementalCompilerSession;
  const revision = session ? incrementalMappingRevision(session.server) : 0;
  if (
    compileRunning ||
    queuedRequest ||
    !session ||
    activeWorkspaceKey !== request.workspaceKey ||
    revision === 0 ||
    revision !== request.expectedRevision
  ) {
    self.postMessage({
      kind: "mapping.result",
      id: request.id,
      ok: false,
      stale: true,
      revision,
      error: compileRunning || queuedRequest ? "Typst mapping is compiling" : "Typst mapping is stale"
    } satisfies TypstMappingResponse);
    return;
  }

  try {
    if (request.kind === "mapping.source-to-document") {
      self.postMessage({
        kind: "mapping.result",
        id: request.id,
        ok: true,
        revision,
        positions: mapSourceToDocument(session.server, request.position)
      } satisfies TypstMappingResponse);
      return;
    }
    self.postMessage({
      kind: "mapping.result",
      id: request.id,
      ok: true,
      revision,
      location: mapDocumentToSource(session.server, request.position)
    } satisfies TypstMappingResponse);
  } catch (error) {
    self.postMessage({
      kind: "mapping.result",
      id: request.id,
      ok: false,
      revision,
      error: error instanceof Error ? error.message : "Typst mapping failed"
    } satisfies TypstMappingResponse);
  }
}

async function drainCompileQueue() {
  if (compileRunning) return;
  compileRunning = true;
  try {
    while (queuedRequest) {
      const request = queuedRequest;
      queuedRequest = null;
      if (request.kind === "prewarm") {
        await handlePrewarm(request);
      } else {
        await handleCompile(request);
      }
    }
  } finally {
    compileRunning = false;
    if (queuedRequest) void drainCompileQueue();
  }
}

async function handlePrewarm(request: PrewarmRequest) {
  try {
    // Prewarming must never replace an already configured workspace compiler
    // (notably one with project fonts or the CJK profile).
    if (typstPromise && configKey) {
      await typstPromise;
      self.postMessage({
        id: request.id,
        ok: true,
        workspaceApplied: false
      } satisfies CompileResponse);
      return;
    }
    const typst = await getTypst(
      request.environment,
      [],
      "",
      request.fontProfile,
    );
    const compiler = await typst.getCompiler();
    await getIncrementalCompilerSession(compiler);
    self.postMessage({
      id: request.id,
      ok: true,
      workspaceApplied: false
    } satisfies CompileResponse);
    self.postMessage({
      kind: "runtime.status",
      stage: "ready"
    } satisfies RuntimeStatusMessage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      id: request.id,
      ok: false,
      workspaceApplied: false,
      errors: [message || "Typst compiler prewarm failed"]
    } satisfies CompileResponse);
  }
}

async function handleCompile(eventData: CompileRequest) {
  const {
    id,
    environment,
    emitPdf = false,
    pdfOnly = false,
    diagnosticsOnly = false,
    forceFullVector = false
  } = eventData;
  const entryFilePath = normalizeWorkspacePath(eventData.entryFilePath || "main.typ");
  let workspaceApplied = false;
  try {
    self.postMessage({
      kind: "runtime.status",
      stage: "compiling"
    } satisfies RuntimeStatusMessage);
    const { documents, assets } = applyWorkspacePatch(eventData);
    workspaceApplied = true;
    self.postMessage({ kind: "workspace.ack", id });
    const typst = await getTypst(
      environment,
      workspaceFontData,
      workspaceFontSignature,
      workspaceFontProfile,
    );
    if (!accessModel) throw new Error("Compiler access model missing");
    await syncShadowFiles(typst, documents, assets);
    const mainFilePath = sourcePath(entryFilePath);
    const compiler = await typst.getCompiler();
    if (diagnosticsOnly) {
      const diagnosticResult = await compiler.runWithWorld({ mainFilePath }, (world) =>
        world.compile({ diagnostics: "unix" })
      );
      const diagnostics = (diagnosticResult.diagnostics || [])
        .map((item) => String(item).trim())
        .filter((item) => !!item)
        .map((item) => parseCompileDiagnostic(item));
      const errorDiagnostics = diagnostics.filter((item) => item.severity === "error");
      self.postMessage({
        id,
        ok: !diagnosticResult.hasError,
        workspaceApplied,
        errors: errorDiagnostics.map((item) => item.raw),
        diagnostics
      } satisfies CompileResponse);
      self.postMessage({
        kind: "runtime.status",
        stage: "ready"
      } satisfies RuntimeStatusMessage);
      return;
    }
    if (pdfOnly) {
      const pdfResult = (await compiler.compile({
        mainFilePath,
        format: CompileFormatEnum.pdf,
        diagnostics: "unix"
      })) as {
        result?: Uint8Array;
        diagnostics?: unknown[];
        hasError?: boolean;
      };
      const diagnostics = (pdfResult.diagnostics || [])
        .map((item) => String(item).trim())
        .filter((item) => !!item)
        .map((item) => parseCompileDiagnostic(item));
      const pdf = !pdfResult.hasError ? pdfResult.result : undefined;
      self.postMessage({
        id,
        ok: !!pdf,
        workspaceApplied,
        pdfBytes: pdf,
        errors: diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => item.raw),
        diagnostics
      } satisfies CompileResponse);
      self.postMessage({
        kind: "runtime.status",
        stage: "ready"
      } satisfies RuntimeStatusMessage);
      return;
    }
    const incrementalSession = await getIncrementalCompilerSession(compiler);
    const shouldReturnFullVector = forceFullVector || !incrementalServerHasState;
    if (forceFullVector && incrementalServerHasState) {
      incrementalSession.server.reset();
      incrementalServerHasState = false;
    }
    const vectorResult = (await compiler.compile({
      mainFilePath,
      incrementalServer: incrementalSession.server,
      diagnostics: "unix"
    })) as {
      result?: Uint8Array;
      diagnostics?: unknown[];
      hasError?: boolean;
    };
    let vector: Uint8Array | undefined;
    let vectorMode: "full" | "delta" | undefined;
    if (vectorResult.result && !vectorResult.hasError) {
      incrementalServerHasState = true;
      // A fresh incremental server emits a self-contained first delta. This is
      // more reliable than IncrServer.current(), whose packed snapshot can omit
      // item definitions required by a newly created renderer session.
      vector = vectorResult.result;
      vectorMode = shouldReturnFullVector ? "full" : "delta";
    }
    const pdfResult =
      emitPdf && vector
        ? ((await compiler.compile({
            mainFilePath,
            format: CompileFormatEnum.pdf,
            diagnostics: "none"
          })) as { result?: Uint8Array })
        : { result: undefined };
    const pdf = pdfResult.result;
    const diagnostics = (vectorResult.diagnostics || [])
      .map((item) => String(item).trim())
      .filter((item) => !!item)
      .map((item) => parseCompileDiagnostic(item));
    const errorDiagnostics = diagnostics.filter((item) => item.severity === "error");
    compileCount += 1;
    if (compileCount % 120 === 0) {
      await compiler.reset();
    }
    self.postMessage({
      id,
      ok: !!vector,
      workspaceApplied,
      vectorBytes: vector,
      vectorMode,
      pdfBytes: pdf,
      mappingRevision: vector ? incrementalMappingRevision(incrementalSession.server) : undefined,
      errors:
        errorDiagnostics.length > 0
          ? errorDiagnostics.map((item) => item.raw)
          : diagnostics.map((item) => item.raw),
      diagnostics
    } satisfies CompileResponse);
    self.postMessage({
      kind: "runtime.status",
      stage: "ready"
    } satisfies RuntimeStatusMessage);
    return;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    self.postMessage({
      id,
      ok: false,
      workspaceApplied,
      errors: [message || "Typst compile failed"]
    } satisfies CompileResponse);
    self.postMessage({
      kind: "runtime.status",
      stage: "idle"
    } satisfies RuntimeStatusMessage);
    if (/memory access out of bounds|unreachable|RuntimeError/i.test(message)) {
      await resetCompilerState();
    }
  }
}
