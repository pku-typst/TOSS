import {
  createTypstRenderer,
  type RenderSession,
  type TypstRenderer
} from "@myriaddreamin/typst.ts";
import {
  absoluteRuntimeModuleUrl,
  loadTypstRuntimeManifest,
  TYPST_RUNTIME_MODULE_CACHE,
  type TypstRuntimeModule,
  verifyRuntimeModule
} from "@/lib/typstRuntime";
import type {
  TypstDocumentPosition,
  TypstMappingResponse,
  TypstSourceLocation,
  TypstSourcePosition
} from "@/lib/typstSync";

export type CompileOutput = {
  vectorData: Uint8Array | null;
  vectorMode: "full" | "delta" | null;
  pdfData: Uint8Array | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  compiledAt: number;
  mappingRevision: number | null;
};

export type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  line?: number;
  column?: number;
  raw: string;
};

type WorkerCompileResponse = {
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

type WorkerRuntimeStatus = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "downloading-package" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
  package_spec?: string;
};

type WorkerWorkspaceAck = {
  kind: "workspace.ack";
  id: number;
};

type WorkerMessage =
  | WorkerCompileResponse
  | WorkerRuntimeStatus
  | WorkerWorkspaceAck
  | TypstMappingResponse;

export type TypstRuntimeStatus = {
  stage: "downloading-compiler" | "downloading-package" | "compiling" | "ready" | "idle";
  loadedBytes?: number;
  totalBytes?: number;
  packageSpec?: string;
};

export type CompileOptions = {
  workspaceKey: string;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  coreApiUrl: string;
  fontData: Uint8Array[];
  emitPdf?: boolean;
  pdfOnly?: boolean;
  diagnosticsOnly?: boolean;
  appOrigin?: string;
};

type WorkspaceSnapshot = {
  workspaceKey: string;
  documents: Map<string, string>;
  assets: Map<string, string>;
  fontData: Uint8Array[];
  fontSignature: string;
};

type PendingWorkerRequest = {
  resolve: (response: WorkerCompileResponse) => void;
  snapshot?: WorkspaceSnapshot;
  workspaceAcknowledged?: boolean;
};

type PendingMappingRequest = {
  resolve: (response: TypstMappingResponse | undefined) => void;
  timeout: number;
};

type PrewarmOptions = {
  coreApiUrl: string;
  appOrigin?: string;
  documents?: Array<{ content: string }>;
};

const CJK_TEXT_PATTERN =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const MAPPING_REQUEST_TIMEOUT_MS = 2_000;
const WORKER_RESET_ERROR = "Typst worker reset after a fatal compiler failure";

class TypstWorkerRuntime {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, PendingWorkerRequest>();
  private pendingMappings = new Map<number, PendingMappingRequest>();
  private listeners = new Set<(status: TypstRuntimeStatus) => void>();
  private acknowledgedSnapshot: WorkspaceSnapshot | null = null;
  private fontIdentities = new WeakMap<Uint8Array, number>();
  private nextFontIdentity = 1;
  private prewarmPromise: Promise<void> | null = null;
  private fatalError(response: WorkerCompileResponse) {
    return (
      !!response.errors &&
      response.errors.some((message) =>
        /memory access out of bounds|unreachable|RuntimeError/i.test(message)
      )
    );
  }

  private resetWorker(pendingCompileError?: string) {
    this.worker?.terminate();
    this.worker = null;
    this.acknowledgedSnapshot = null;
    this.prewarmPromise = null;
    if (pendingCompileError) {
      for (const [id, pending] of this.pending) {
        pending.resolve({ id, ok: false, errors: [pendingCompileError] });
      }
      this.pending.clear();
    }
    for (const pending of this.pendingMappings.values()) {
      window.clearTimeout(pending.timeout);
      pending.resolve(undefined);
    }
    this.pendingMappings.clear();
  }

  dispose() {
    this.resetWorker("Typst candidate compiler disposed after becoming idle");
    this.notify({ stage: "idle" });
  }

  private fontIdentity(bytes: Uint8Array) {
    let identity = this.fontIdentities.get(bytes);
    if (identity === undefined) {
      identity = this.nextFontIdentity;
      this.nextFontIdentity += 1;
      this.fontIdentities.set(bytes, identity);
    }
    return `${bytes.byteLength}:${identity}`;
  }

  private snapshot(options: CompileOptions): WorkspaceSnapshot {
    const documents = new Map(options.documents.map((document) => [document.path, document.content]));
    const assets = new Map(options.assets.map((asset) => [asset.path, asset.contentBase64]));
    const fontData = options.fontData.slice();
    return {
      workspaceKey: options.workspaceKey,
      documents,
      assets,
      fontData,
      fontSignature: fontData.map((font) => this.fontIdentity(font)).join("|")
    };
  }

  private workspacePatch(snapshot: WorkspaceSnapshot, forceReset = false) {
    const baseline = this.acknowledgedSnapshot;
    const resetWorkspace =
      forceReset || !baseline || baseline.workspaceKey !== snapshot.workspaceKey;
    const documentUpserts: Array<{ path: string; content: string }> = [];
    const documentDeletes: string[] = [];
    const assetUpserts: Array<{ path: string; content_base64: string }> = [];
    const assetDeletes: string[] = [];

    for (const [path, content] of snapshot.documents) {
      if (resetWorkspace || baseline?.documents.get(path) !== content) {
        documentUpserts.push({ path, content });
      }
    }
    if (!resetWorkspace && baseline) {
      for (const path of baseline.documents.keys()) {
        if (!snapshot.documents.has(path)) documentDeletes.push(path);
      }
    }
    for (const [path, content_base64] of snapshot.assets) {
      if (resetWorkspace || baseline?.assets.get(path) !== content_base64) {
        assetUpserts.push({ path, content_base64 });
      }
    }
    if (!resetWorkspace && baseline) {
      for (const path of baseline.assets.keys()) {
        if (!snapshot.assets.has(path)) assetDeletes.push(path);
      }
    }

    const fontsChanged = resetWorkspace || baseline?.fontSignature !== snapshot.fontSignature;
    return {
      workspaceKey: snapshot.workspaceKey,
      resetWorkspace,
      documentUpserts,
      documentDeletes,
      assetUpserts,
      assetDeletes,
      fontData: fontsChanged ? snapshot.fontData : undefined,
      fontSignature: fontsChanged ? snapshot.fontSignature : undefined
    };
  }

  private ensureWorker() {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./typst.worker.ts", import.meta.url), {
      type: "module"
    });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const response = event.data;
      if (response && "kind" in response && response.kind === "mapping.result") {
        const pending = this.pendingMappings.get(response.id);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        this.pendingMappings.delete(response.id);
        pending.resolve(response);
        return;
      }
      if (response && "kind" in response && response.kind === "workspace.ack") {
        const pending = this.pending.get(response.id);
        if (pending?.snapshot) {
          this.acknowledgedSnapshot = pending.snapshot;
          pending.workspaceAcknowledged = true;
        }
        return;
      }
      if (response && "kind" in response && response.kind === "runtime.status") {
        const status: TypstRuntimeStatus = {
          stage: response.stage,
          loadedBytes: response.loaded_bytes,
          totalBytes: response.total_bytes,
          packageSpec: response.package_spec
        };
        this.notify(status);
        return;
      }
      const compileResponse = response as WorkerCompileResponse;
      const pending = this.pending.get(compileResponse.id);
      if (!pending) return;
      this.pending.delete(compileResponse.id);
      if (compileResponse.workspaceApplied && pending.snapshot) {
        this.acknowledgedSnapshot = pending.snapshot;
      }
      if (compileResponse.ok && compileResponse.vectorBytes && compileResponse.vectorMode) {
        void preparePersistentVectorArtifact(
          compileResponse.vectorBytes,
          compileResponse.vectorMode
        )
          .then(() => pending.resolve(compileResponse))
          .catch((error) => {
            const message = error instanceof Error ? error.message : "Incremental preview session failed";
            pending.resolve({
              ...compileResponse,
              ok: false,
              errors: [message]
            });
          });
        return;
      }
      pending.resolve(compileResponse);
    };
    this.worker.onerror = (event) => {
      const detail =
        event && "message" in event && typeof event.message === "string"
          ? event.message
          : "Typst worker crashed";
      this.resetWorker(detail);
      this.notify({ stage: "idle" });
    };
    return this.worker;
  }

  private notify(status: TypstRuntimeStatus) {
    for (const listener of this.listeners) listener(status);
  }

  subscribe(listener: (status: TypstRuntimeStatus) => void) {
    this.listeners.add(listener);
    listener({ stage: "idle" });
    return () => {
      this.listeners.delete(listener);
    };
  }

  compile(options: CompileOptions): Promise<WorkerCompileResponse> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: ["This browser does not support Worker-based Typst preview"]
      });
    }
    const id = this.seq++;
    const snapshot = this.snapshot(options);
    // If another workspace request is still in flight, the worker may already
    // have applied it even though its acknowledgement has not reached us. A
    // full reset keeps later edits correct for add/delete and font rollbacks.
    const hasUnacknowledgedWorkspaceRequest = Array.from(this.pending.values()).some(
      (pending) => !!pending.snapshot && !pending.workspaceAcknowledged
    );
    const patch = this.workspacePatch(snapshot, hasUnacknowledgedWorkspaceRequest);
    return new Promise<WorkerCompileResponse>((resolve) => {
      this.pending.set(id, { resolve, snapshot });
      worker.postMessage({
        kind: "compile",
        id,
        entryFilePath: options.entryFilePath,
        ...patch,
        coreApiUrl: options.coreApiUrl,
        emitPdf: options.emitPdf ?? false,
        pdfOnly: options.pdfOnly ?? false,
        diagnosticsOnly: options.diagnosticsOnly ?? false,
        forceFullVector: persistentRendererNeedsFullArtifact(),
        appOrigin: options.appOrigin
      });
    }).then((response) => {
      if (!response.ok && this.fatalError(response)) {
        this.resetWorker(WORKER_RESET_ERROR);
      }
      return response;
    });
  }

  private requestMapping(
    request:
      | {
          kind: "mapping.source-to-document";
          workspaceKey: string;
          expectedRevision: number;
          position: TypstSourcePosition;
        }
      | {
          kind: "mapping.document-to-source";
          workspaceKey: string;
          expectedRevision: number;
          position: TypstDocumentPosition;
        }
  ): Promise<TypstMappingResponse | undefined> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(undefined);
    const id = this.seq++;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        this.pendingMappings.delete(id);
        resolve(undefined);
      }, MAPPING_REQUEST_TIMEOUT_MS);
      this.pendingMappings.set(id, { resolve, timeout });
      worker.postMessage({ ...request, id });
    });
  }

  async sourceToDocument(options: {
    workspaceKey: string;
    expectedRevision: number;
    position: TypstSourcePosition;
  }): Promise<TypstDocumentPosition[] | undefined> {
    const response = await this.requestMapping({
      kind: "mapping.source-to-document",
      ...options
    });
    if (!response?.ok || response.revision !== options.expectedRevision) return undefined;
    return response.positions ?? [];
  }

  async documentToSource(options: {
    workspaceKey: string;
    expectedRevision: number;
    position: TypstDocumentPosition;
  }): Promise<TypstSourceLocation | undefined> {
    const response = await this.requestMapping({
      kind: "mapping.document-to-source",
      ...options
    });
    if (!response?.ok || response.revision !== options.expectedRevision) return undefined;
    return response.location;
  }

  prewarm(options: PrewarmOptions): Promise<void> {
    if (this.prewarmPromise) return this.prewarmPromise;
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve();
    const id = this.seq++;
    this.notify({ stage: "downloading-compiler" });
    this.prewarmPromise = new Promise<WorkerCompileResponse>((resolve) => {
      this.pending.set(id, { resolve });
      worker.postMessage({
        kind: "prewarm",
        id,
        coreApiUrl: options.coreApiUrl,
        fontProfile: options.documents?.some((document) => CJK_TEXT_PATTERN.test(document.content))
          ? "cjk"
          : "latin",
        appOrigin: options.appOrigin
      });
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(response.errors?.[0] ?? "Typst compiler prewarm failed");
        }
        this.notify({ stage: "ready" });
      })
      .catch((error) => {
        this.prewarmPromise = null;
        this.notify({ stage: "idle" });
        throw error;
      });
    return this.prewarmPromise;
  }
}

let rendererPromise: ReturnType<typeof createTypstRenderer> | null = null;
let renderVersion = 0;
type PersistentRendererSession = {
  renderer: TypstRenderer;
  session: RenderSession;
  release: () => void;
  task: Promise<void>;
  lastArtifact: Uint8Array | null;
};
let persistentRendererSession: PersistentRendererSession | null = null;
let persistentRendererSessionPromise: Promise<PersistentRendererSession> | null = null;
let persistentRendererRequiresFullArtifact = true;
let rendererOperationTail: Promise<void> = Promise.resolve();
const FULL_VECTOR_PREFIX = new Uint8Array([0x6e, 0x65, 0x77, 0x2c]);
const DELTA_VECTOR_PREFIX = new Uint8Array([0x64, 0x69, 0x66, 0x66, 0x2d, 0x76, 0x31, 0x2c]);

function enqueueRendererOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = rendererOperationTail.catch(() => undefined).then(operation);
  rendererOperationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function persistentRendererNeedsFullArtifact() {
  return persistentRendererRequiresFullArtifact || !persistentRendererSession;
}

async function createPersistentRendererSession(renderer: TypstRenderer) {
  let release: () => void = () => undefined;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveReady!: (session: RenderSession) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<RenderSession>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const task = renderer.runWithSession(async (session) => {
    resolveReady(session);
    await lifetime;
  });
  void task.catch(rejectReady);
  const session = await ready;
  return {
    renderer,
    session,
    release,
    task,
    lastArtifact: null
  } satisfies PersistentRendererSession;
}

async function getPersistentRendererSession(renderer: TypstRenderer) {
  if (persistentRendererSession?.renderer === renderer) return persistentRendererSession;
  if (persistentRendererSessionPromise) return persistentRendererSessionPromise;
  persistentRendererSessionPromise = createPersistentRendererSession(renderer);
  try {
    persistentRendererSession = await persistentRendererSessionPromise;
    return persistentRendererSession;
  } finally {
    persistentRendererSessionPromise = null;
  }
}

async function disposePersistentRendererSession() {
  const state = persistentRendererSession;
  persistentRendererSession = null;
  persistentRendererSessionPromise = null;
  persistentRendererRequiresFullArtifact = true;
  if (!state) return;
  state.release();
  await state.task.catch(() => undefined);
}

function unpackIncrementalVectorArtifact(artifact: Uint8Array, mode: "full" | "delta") {
  const matchingPrefix = [DELTA_VECTOR_PREFIX, ...(mode === "full" ? [FULL_VECTOR_PREFIX] : [])].find(
    (prefix) =>
      artifact.byteLength > prefix.byteLength &&
      prefix.every((byte, index) => artifact[index] === byte)
  );
  if (!matchingPrefix) {
    throw new Error(`Invalid ${mode} incremental vector artifact`);
  }
  // The renderer consumes the raw rkyv payload rather than the wire envelope.
  // slice() also gives the payload a fresh, aligned backing buffer; a subarray
  // after the four-byte `new,` prefix would violate rkyv's 8-byte alignment.
  return artifact.slice(matchingPrefix.byteLength);
}

function preparePersistentVectorArtifact(
  artifact: Uint8Array,
  mode: "full" | "delta"
) {
  return enqueueRendererOperation(async () => {
    const renderer = await getRenderer();
    if (mode === "delta" && persistentRendererNeedsFullArtifact()) {
      throw new Error("Incremental preview requires a full vector snapshot");
    }
    const state = await getPersistentRendererSession(renderer);
    try {
      const payload = unpackIncrementalVectorArtifact(artifact, mode);
      renderer.manipulateData({
        renderSession: state.session,
        action: mode === "full" ? "reset" : "merge",
        data: payload
      });
      state.lastArtifact = artifact;
      persistentRendererRequiresFullArtifact = false;
    } catch (error) {
      await disposePersistentRendererSession();
      throw error;
    }
  });
}

async function readCachedRendererModule(url: string): Promise<ArrayBuffer | null> {
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

async function writeCachedRendererModule(url: string, bytes: Uint8Array) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(TYPST_RUNTIME_MODULE_CACHE);
    await cache.put(
      url,
      new Response(new Blob([new Uint8Array(bytes).buffer]), {
        headers: {
          "content-type": "application/wasm",
          "x-runtime-module": "renderer",
          "cache-control": "public, max-age=31536000, immutable"
        }
      })
    );
  } catch {
    // best effort only
  }
}

async function deleteCachedRendererModule(url: string) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(TYPST_RUNTIME_MODULE_CACHE);
    await cache.delete(url);
  } catch {
    // best effort only
  }
}

async function fetchRendererModule(url: string, module: TypstRuntimeModule) {
  const cached = await readCachedRendererModule(url);
  if (cached) {
    try {
      await verifyRuntimeModule(cached, module, "renderer wasm");
      return cached;
    } catch {
      await deleteCachedRendererModule(url);
    }
  }
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`renderer wasm fetch failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyRuntimeModule(bytes, module, "renderer wasm");
  await writeCachedRendererModule(url, bytes);
  return bytes.buffer;
}

async function getRenderer() {
  if (!rendererPromise) {
    const renderer = createTypstRenderer();
    const appOrigin = window.location.origin;
    const manifest = await loadTypstRuntimeManifest(appOrigin);
    const rendererUrl = absoluteRuntimeModuleUrl(manifest.renderer, appOrigin);
    await renderer.init({
      // Keep the promise inside wasm-bindgen's object-form initialization argument.
      getModule: () => ({
        module_or_path: fetchRendererModule(rendererUrl, manifest.renderer)
      })
    });
    rendererPromise = renderer;
  }
  return rendererPromise;
}

type RendererPageInfo = ReturnType<RenderSession["retrievePagesInfo"]>[number];

type PersistentCanvasPage = {
  element: HTMLDivElement;
  transform: HTMLDivElement;
  canvas: HTMLCanvasElement;
  info: RendererPageInfo;
  cacheKey: string | null;
  pixelPerPt: number;
  desiredCanvasWidth: number;
  desiredCanvasHeight: number;
  baseWidth: number;
  baseHeight: number;
};

type PersistentCanvasDocument = {
  container: HTMLElement;
  pagesElement: HTMLDivElement;
  pages: PersistentCanvasPage[];
  renderer: TypstRenderer;
  session: RenderSession;
  version: number;
  pendingPages: Set<number>;
  cancelBackgroundRender: (() => void) | null;
};

const persistentCanvasDocuments = new WeakMap<HTMLElement, PersistentCanvasDocument>();

function createCanvasPage(info: RendererPageInfo): PersistentCanvasPage {
  const element = document.createElement("div");
  element.className = "typst-page canvas";
  element.style.position = "relative";
  element.style.overflow = "hidden";

  const transform = document.createElement("div");
  transform.style.position = "absolute";
  transform.style.inset = "0 auto auto 0";
  transform.style.transformOrigin = "0 0";

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.display = "block";
  transform.appendChild(canvas);
  element.appendChild(transform);

  return {
    element,
    transform,
    canvas,
    info,
    cacheKey: null,
    pixelPerPt: 1,
    desiredCanvasWidth: 1,
    desiredCanvasHeight: 1,
    baseWidth: 1,
    baseHeight: 1
  };
}

function syncCanvasPageLayout(page: PersistentCanvasPage) {
  const canvasWidth = Math.max(1, page.canvas.width);
  const canvasHeight = Math.max(1, page.canvas.height);
  const displayWidth = Math.max(
    1,
    Number.parseFloat(page.element.style.width || "") || page.baseWidth
  );
  const displayHeight = Math.max(
    1,
    Number.parseFloat(page.element.style.height || "") || page.baseHeight
  );
  page.element.dataset.baseWidth = `${page.baseWidth}`;
  page.element.dataset.baseHeight = `${page.baseHeight}`;
  page.element.dataset.baseScale = "1";
  page.element.dataset.canvasWidth = `${canvasWidth}`;
  page.element.dataset.canvasHeight = `${canvasHeight}`;
  page.element.dataset.typstPageOffset = `${page.info.pageOffset}`;
  page.element.style.width = `${displayWidth}px`;
  page.element.style.height = `${displayHeight}px`;
  page.canvas.dataset.baseWidth = `${canvasWidth}`;
  page.canvas.dataset.baseHeight = `${canvasHeight}`;
  page.canvas.style.width = `${canvasWidth}px`;
  page.canvas.style.height = `${canvasHeight}px`;
  page.transform.style.width = `${canvasWidth}px`;
  page.transform.style.height = `${canvasHeight}px`;
  page.transform.style.transform = `scale(${displayWidth / canvasWidth}, ${displayHeight / canvasHeight})`;
}

function configureCanvasPage(
  page: PersistentCanvasPage,
  info: RendererPageInfo,
  pixelPerPt: number
) {
  const previousDisplayWidth = Number.parseFloat(page.element.style.width || "");
  const previousDisplayHeight = Number.parseFloat(page.element.style.height || "");
  const scaleX =
    Number.isFinite(previousDisplayWidth) && page.baseWidth > 0
      ? previousDisplayWidth / page.baseWidth
      : 1;
  const scaleY =
    Number.isFinite(previousDisplayHeight) && page.baseHeight > 0
      ? previousDisplayHeight / page.baseHeight
      : 1;
  page.info = info;
  page.pixelPerPt = pixelPerPt;
  page.desiredCanvasWidth = Math.max(1, Math.ceil(Math.ceil(info.width) * pixelPerPt));
  page.desiredCanvasHeight = Math.max(1, Math.ceil(Math.ceil(info.height) * pixelPerPt));
  page.baseWidth = page.desiredCanvasWidth / pixelPerPt;
  page.baseHeight = page.desiredCanvasHeight / pixelPerPt;
  page.element.style.width = `${page.baseWidth * scaleX}px`;
  page.element.style.height = `${page.baseHeight * scaleY}px`;
  syncCanvasPageLayout(page);
}

function reconcileCanvasDocument(
  state: PersistentCanvasDocument,
  pageInfos: RendererPageInfo[],
  pixelPerPt: number
) {
  while (state.pages.length > pageInfos.length) {
    state.pages.pop()?.element.remove();
  }
  for (let index = 0; index < pageInfos.length; index += 1) {
    let page = state.pages[index];
    if (!page) {
      page = createCanvasPage(pageInfos[index]);
      state.pages.push(page);
      state.pagesElement.appendChild(page.element);
    }
    configureCanvasPage(page, pageInfos[index], pixelPerPt);
  }
}

function pageIntersectsViewport(container: HTMLElement, page: PersistentCanvasPage) {
  if (page.element.parentElement?.parentElement !== container) return false;
  const containerRect = container.getBoundingClientRect();
  const pageRect = page.element.getBoundingClientRect();
  return (
    pageRect.bottom >= containerRect.top &&
    pageRect.top <= containerRect.bottom &&
    pageRect.right >= containerRect.left &&
    pageRect.left <= containerRect.right
  );
}

function orderedPendingPages(state: PersistentCanvasDocument) {
  const indices = Array.from(state.pendingPages);
  if (state.pagesElement.parentElement !== state.container) {
    return indices.sort((left, right) => left - right);
  }
  const containerRect = state.container.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;
  return indices.sort((left, right) => {
    const leftPage = state.pages[left];
    const rightPage = state.pages[right];
    const leftRect = leftPage.element.getBoundingClientRect();
    const rightRect = rightPage.element.getBoundingClientRect();
    const leftVisible = pageIntersectsViewport(state.container, leftPage);
    const rightVisible = pageIntersectsViewport(state.container, rightPage);
    if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
    const leftDistance = Math.abs(leftRect.top + leftRect.height / 2 - centerY);
    const rightDistance = Math.abs(rightRect.top + rightRect.height / 2 - centerY);
    return leftDistance - rightDistance;
  });
}

function requestDeferredRender(callback: () => void) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 160 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 32);
  return () => window.clearTimeout(handle);
}

async function renderCanvasPage(state: PersistentCanvasDocument, index: number) {
  const page = state.pages[index];
  if (!page) return;
  const resized =
    page.canvas.width !== page.desiredCanvasWidth ||
    page.canvas.height !== page.desiredCanvasHeight;
  if (resized) {
    page.canvas.width = page.desiredCanvasWidth;
    page.canvas.height = page.desiredCanvasHeight;
    page.cacheKey = null;
  }
  syncCanvasPageLayout(page);
  const context = page.canvas.getContext("2d");
  if (!context) throw new Error(`Canvas context is unavailable for Typst page ${index + 1}`);
  const startedAt = performance.now();
  const result = await state.renderer.renderCanvas({
    renderSession: state.session,
    canvas: context,
    pageOffset: page.info.pageOffset,
    cacheKey: page.cacheKey ?? undefined,
    backgroundColor: "#ffffff",
    pixelPerPt: page.pixelPerPt,
    dataSelection: {
      body: true,
      semantics: false
    }
  });
  page.cacheKey = result.cacheKey;
  page.canvas.dataset.typstCacheKey = result.cacheKey;
  page.canvas.dataset.typstReady = "true";
  page.canvas.dataset.typstRenderMs = `${Math.round((performance.now() - startedAt) * 10) / 10}`;
  page.element.classList.remove("is-render-pending");
}

function scheduleBackgroundCanvasRender(state: PersistentCanvasDocument, version: number) {
  state.cancelBackgroundRender?.();
  state.cancelBackgroundRender = null;
  if (
    version !== state.version ||
    version !== renderVersion ||
    state.pendingPages.size === 0 ||
    state.pagesElement.parentElement !== state.container
  ) {
    return;
  }
  state.cancelBackgroundRender = requestDeferredRender(() => {
    state.cancelBackgroundRender = null;
    if (version !== state.version || version !== renderVersion) return;
    const index = orderedPendingPages(state)[0];
    if (index === undefined) return;
    state.pendingPages.delete(index);
    void enqueueRendererOperation(async () => {
      if (version !== state.version || version !== renderVersion) return;
      await renderCanvasPage(state, index);
    }).then(
      () => scheduleBackgroundCanvasRender(state, version),
      (error) => {
        console.warn("Deferred Typst page render failed", error);
      }
    );
  });
}

function getCanvasDocument(
  container: HTMLElement,
  renderer: TypstRenderer,
  session: RenderSession
) {
  const existing = persistentCanvasDocuments.get(container);
  if (existing) {
    existing.renderer = renderer;
    existing.session = session;
    return existing;
  }
  const pagesElement = document.createElement("div");
  pagesElement.className = "pdf-pages";
  const state: PersistentCanvasDocument = {
    container,
    pagesElement,
    pages: [],
    renderer,
    session,
    version: 0,
    pendingPages: new Set(),
    cancelBackgroundRender: null
  };
  persistentCanvasDocuments.set(container, state);
  return state;
}

const runtime = new TypstWorkerRuntime();
const CANDIDATE_RUNTIME_IDLE_MS = 60_000;
let candidateRuntime: TypstWorkerRuntime | null = null;
let candidateRuntimeIdleTimer: number | null = null;

function activeCandidateRuntime() {
  if (candidateRuntimeIdleTimer !== null) {
    window.clearTimeout(candidateRuntimeIdleTimer);
    candidateRuntimeIdleTimer = null;
  }
  candidateRuntime ??= new TypstWorkerRuntime();
  return candidateRuntime;
}

function releaseCandidateRuntimeWhenIdle(selectedRuntime: TypstWorkerRuntime) {
  if (candidateRuntimeIdleTimer !== null) {
    window.clearTimeout(candidateRuntimeIdleTimer);
  }
  candidateRuntimeIdleTimer = window.setTimeout(() => {
    if (candidateRuntime !== selectedRuntime) return;
    selectedRuntime.dispose();
    candidateRuntime = null;
    candidateRuntimeIdleTimer = null;
  }, CANDIDATE_RUNTIME_IDLE_MS);
}

async function compileTypstWithRuntime(
  selectedRuntime: TypstWorkerRuntime,
  options: CompileOptions,
): Promise<CompileOutput> {
  if (!options.documents.length) {
    return {
      vectorData: null,
      vectorMode: null,
      pdfData: null,
      errors: ["Project has no source documents"],
      diagnostics: [],
      compiledAt: Date.now(),
      mappingRevision: null
    };
  }
  const result = await selectedRuntime.compile(options);
  if (options.diagnosticsOnly && result.ok) {
    return {
      vectorData: null,
      vectorMode: null,
      pdfData: null,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now(),
      mappingRevision: null
    };
  }
  if (options.pdfOnly && result.ok && result.pdfBytes && result.pdfBytes.byteLength > 0) {
    return {
      vectorData: null,
      vectorMode: null,
      pdfData: result.pdfBytes,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now(),
      mappingRevision: null
    };
  }
  if (result.ok && result.vectorBytes && result.vectorBytes.byteLength > 0) {
    return {
      vectorData: result.vectorBytes,
      vectorMode: result.vectorMode ?? "full",
      pdfData: result.pdfBytes ?? null,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now(),
      mappingRevision: result.mappingRevision ?? null
    };
  }
  return {
    vectorData: null,
    vectorMode: null,
    pdfData: null,
    errors: result.errors?.length
      ? result.errors
      : [
          "This browser cannot run Typst WASM preview. You can continue editing source and sync via Git for offline compilation."
        ],
    diagnostics: result.diagnostics ?? [],
    compiledAt: Date.now(),
    mappingRevision: null
  };
}

export function compileTypstClientSide(options: CompileOptions) {
  return compileTypstWithRuntime(runtime, options);
}

/** Uses a dedicated worker and diagnostics-only compilation so candidate edits
 * cannot supersede live preview work or mutate its incremental renderer session. */
export async function compileTypstCandidateClientSide(
  options: Omit<CompileOptions, "emitPdf" | "pdfOnly" | "diagnosticsOnly">,
) {
  const selectedRuntime = activeCandidateRuntime();
  try {
    const output = await compileTypstWithRuntime(selectedRuntime, {
      ...options,
      emitPdf: false,
      pdfOnly: false,
      diagnosticsOnly: true,
    });
    return { ...output, pdfData: null };
  } finally {
    releaseCandidateRuntimeWhenIdle(selectedRuntime);
  }
}

export function subscribeTypstRuntimeStatus(listener: (status: TypstRuntimeStatus) => void) {
  return runtime.subscribe(listener);
}

export function prewarmTypstClientSide(options: PrewarmOptions) {
  return runtime.prewarm(options);
}

export function resolveTypstSourceToDocument(options: {
  workspaceKey: string;
  expectedRevision: number;
  position: TypstSourcePosition;
}) {
  return runtime.sourceToDocument(options);
}

export function resolveTypstDocumentToSource(options: {
  workspaceKey: string;
  expectedRevision: number;
  position: TypstDocumentPosition;
}) {
  return runtime.documentToSource(options);
}

export async function renderTypstVectorToCanvas(
  container: HTMLElement,
  vectorData: Uint8Array,
  options?: { pixelPerPt?: number }
) {
  const version = ++renderVersion;
  const pixelPerPt = Math.max(0.25, Math.min(12, options?.pixelPerPt ?? 3));
  void vectorData;
  await enqueueRendererOperation(async () => {
    if (version !== renderVersion) return;
    const renderer = await getRenderer();
    const rendererSession = persistentRendererSession;
    if (
      !rendererSession ||
      rendererSession.renderer !== renderer ||
      persistentRendererRequiresFullArtifact ||
      !rendererSession.lastArtifact
    ) {
      throw new Error("Incremental preview session is not initialized");
    }
    if (version !== renderVersion) return;
    const state = getCanvasDocument(container, renderer, rendererSession.session);
    state.cancelBackgroundRender?.();
    state.cancelBackgroundRender = null;
    state.version = version;
    const pageInfos = renderer.retrievePagesInfoFromSession(rendererSession.session);
    if (pageInfos.length === 0) throw new Error("No page found in Typst renderer session");
    reconcileCanvasDocument(state, pageInfos, pixelPerPt);
    state.pagesElement.dataset.typstRenderVersion = `${version}`;
    state.pendingPages = new Set(pageInfos.map((_, index) => index));
    for (const page of state.pages) page.element.classList.add("is-render-pending");

    const ordered = orderedPendingPages(state);
    const visible = ordered.filter((index) => pageIntersectsViewport(container, state.pages[index]));
    const primaryPages = visible.length > 0 ? visible : ordered.slice(0, 1);
    for (const index of primaryPages) {
      if (version !== renderVersion || version !== state.version) return;
      state.pendingPages.delete(index);
      await renderCanvasPage(state, index);
      if (state.pagesElement.parentElement !== container) {
        container.replaceChildren(state.pagesElement);
      }
    }
    if (version !== renderVersion) return;
    if (state.pagesElement.parentElement !== container) {
      container.replaceChildren(state.pagesElement);
    }
    scheduleBackgroundCanvasRender(state, version);
  });
}
