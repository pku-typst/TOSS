import type { CompileDiagnostic } from "@/lib/typst";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";

export type LatexCompileOutput = {
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  compiledAt: number;
};

export type LatexRuntimeStatus = {
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loadedBytes?: number;
  totalBytes?: number;
};

type CompileOptions = {
  workspaceKey: string;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  environment: CompilationEnvironment["latex"];
  engine: "pdftex" | "xetex";
};

export async function compileLatexClientSide(
  _options: CompileOptions
): Promise<LatexCompileOutput> {
  return {
    vectorData: null,
    pdfData: null,
    errors: ["LaTeX is disabled for this deployment"],
    diagnostics: [],
    compiledAt: Date.now()
  };
}

export function compileLatexCandidateClientSide(
  options: CompileOptions,
  _signal?: AbortSignal
) {
  return compileLatexClientSide(options);
}

export function subscribeLatexRuntimeStatus(
  listener: (status: LatexRuntimeStatus) => void
) {
  listener({ stage: "idle" });
  return () => undefined;
}
