import { useRuntimeCompilationEnvironment } from "@/composition/applicationRuntime";
import type { TypstPackageSource } from "@/lib/typstUniverse";

export type CompilationEnvironment = {
  typst: {
    builtinBaseUrl: string;
    builtinCredentials: RequestCredentials;
    packageSource: TypstPackageSource;
    runtimeBaseUrl: string;
    fontAssetsBaseUrl: string;
  };
  latex: {
    runtimeBaseUrl: string;
    texliveBaseUrl: string;
  } | null;
};

export function useCompilationEnvironment() {
  return useRuntimeCompilationEnvironment();
}
