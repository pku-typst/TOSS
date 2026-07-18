import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";
import { coreApiBaseUrl } from "@/lib/api";

function trailingSlash(value: string) {
  return `${value.replace(/\/+$/, "")}/`;
}

export function createCoreCompilationEnvironment(): CompilationEnvironment {
  const staticBaseUrl = new URL("/", window.location.origin).toString();
  const coreBaseUrl = (coreApiBaseUrl() || window.location.origin).replace(/\/+$/, "");
  return {
    typst: {
      builtinBaseUrl: `${coreBaseUrl}/v1/typst/builtin/`,
      builtinCredentials: "include",
      packageSource: {
        kind: "toss",
        baseUrl: `${coreBaseUrl}/v1/typst/packages/`,
        withCredentials: true,
      },
      runtimeBaseUrl: new URL("typst-runtime/", staticBaseUrl).toString(),
      fontAssetsBaseUrl: new URL(
        "vendor/typst-assets/fonts/",
        staticBaseUrl,
      ).toString(),
    },
    latex: {
      runtimeBaseUrl: new URL("busytex/", staticBaseUrl).toString(),
      texliveBaseUrl: trailingSlash(`${coreBaseUrl}/v1/latex/texlive`),
    },
  };
}
