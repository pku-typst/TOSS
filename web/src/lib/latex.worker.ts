import busyTexBuildManifest from "../../../prebuilt/busytex/build-manifest.json";
import { BusyTexCompiler } from "./busyTexCompiler";
import type { CompileDiagnostic } from "./typst";
import {
  normalizeLatexWorkspacePath,
  parseLatexCompileDiagnostics,
  summarizeLatexCompileErrors,
} from "./latexRuntimeUtils";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";

type CompileRequest = {
  id: number;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; content_base64: string }>;
  environment: NonNullable<CompilationEnvironment["latex"]>;
  engine: "pdftex" | "xetex";
};

type CompileResponse = {
  id: number;
  ok: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

type RuntimeStatusMessage = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
};

const BUSYTEX_VERSION = busyTexBuildManifest.runtime_version;
let compilerKey = "";
let compiler: BusyTexCompiler | null = null;

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function runtimeFor(request: CompileRequest) {
  const remoteEndpoint = request.environment.texliveBaseUrl;
  const basePath = new URL(
    `${BUSYTEX_VERSION}/`,
    request.environment.runtimeBaseUrl,
  ).toString().replace(/\/$/, "");
  const nextKey = `${basePath}:${remoteEndpoint}`;
  if (compiler && compilerKey === nextKey) return compiler;
  compiler?.close();
  compilerKey = nextKey;
  compiler = new BusyTexCompiler({
    basePath,
    remoteEndpoint,
    onStatus: (status) => {
      self.postMessage({
        kind: "runtime.status",
        stage: status.stage,
        loaded_bytes: status.loadedBytes,
        total_bytes: status.totalBytes,
      } satisfies RuntimeStatusMessage);
    },
  });
  return compiler;
}

async function compileWithBusyTex(request: CompileRequest): Promise<CompileResponse> {
  const entryFilePath = normalizeLatexWorkspacePath(request.entryFilePath, "main.tex");
  const result = await runtimeFor(request).compile({
    engine: request.engine,
    entryFilePath,
    documents: request.documents.map((document) => ({
      path: normalizeLatexWorkspacePath(document.path),
      content: document.content,
    })),
    assets: request.assets.map((asset) => ({
      path: normalizeLatexWorkspacePath(asset.path),
      content: base64ToUint8(asset.content_base64),
    })),
  });
  if (result.success && result.pdf && result.pdf.byteLength > 0) {
    return {
      id: request.id,
      ok: true,
      pdfBytes: result.pdf,
      errors: [],
      diagnostics: [],
    };
  }
  const log = result.log || result.logs.map((entry) => entry.log).join("\n");
  const diagnostics = parseLatexCompileDiagnostics(log);
  const errors =
    diagnostics.length > 0
      ? diagnostics.map((item) => item.raw)
      : summarizeLatexCompileErrors(log);
  return {
    id: request.id,
    ok: false,
    errors:
      errors.length > 0
        ? errors
        : [`LaTeX compilation failed with exit code ${result.exitCode}`],
    diagnostics,
  };
}

async function handleCompile(request: CompileRequest) {
  try {
    const response = await compileWithBusyTex(request);
    self.postMessage(response);
    self.postMessage({
      kind: "runtime.status",
      stage: "ready",
    } satisfies RuntimeStatusMessage);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "LaTeX compile failed";
    self.postMessage({
      id: request.id,
      ok: false,
      errors: [message],
      diagnostics: [],
    } satisfies CompileResponse);
    self.postMessage({
      kind: "runtime.status",
      stage: "idle",
    } satisfies RuntimeStatusMessage);
  }
}

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  void handleCompile(event.data);
};
