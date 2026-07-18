import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";
import { compileLatexCandidateClientSide } from "@/lib/latex";
import {
  compileTypstCandidateClientSide,
  type CompileDiagnostic,
} from "@/lib/typst";
import { checkTypstSyntax } from "@/lib/typstSyntax";
import {
  compileWorldFontData,
  type CompileTarget,
  type CompileWorld,
} from "@/pages/workspace/compileWorld";

export type WorkspaceCandidateCompilation = {
  errors: string[];
  diagnostics: CompileDiagnostic[];
};

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Compiles an unpublished candidate World through a lane isolated from live
 * preview compilation. The caller still owns source/revision validation.
 */
export async function compileWorkspaceCandidate(
  environment: CompilationEnvironment,
  world: CompileWorld,
  target: CompileTarget,
  candidatePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceCandidateCompilation> {
  checkAbort(signal);
  if (target.kind === "typst" && candidatePath.toLowerCase().endsWith(".typ")) {
    const candidateSource = world.source(candidatePath);
    if (candidateSource !== undefined) {
      try {
        const diagnostics = checkTypstSyntax(candidatePath, candidateSource);
        if (diagnostics.length > 0) {
          return {
            errors: diagnostics.map(({ raw }) => raw),
            diagnostics,
          };
        }
      } catch {
        // A parser bootstrap failure must not replace the authoritative compiler.
      }
    }
  }
  checkAbort(signal);
  const common = {
    workspaceKey: world.scope,
    entryFilePath: world.entryFilePath,
    documents: world.documents.slice(),
    assets: world.assets.slice(),
  };
  const output = target.kind === "latex"
      ? await compileLatexCandidateClientSide({
          ...common,
          environment: environment.latex,
          engine: target.engine,
        }, signal)
      : await compileTypstCandidateClientSide({
          ...common,
          environment: environment.typst,
          fontData: compileWorldFontData(world).slice(),
        }, signal);
  checkAbort(signal);
  return {
    errors: output.errors,
    diagnostics: output.diagnostics,
  };
}
