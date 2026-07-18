import type { ApplicationRuntime } from "@/composition/applicationRuntime";
import type { CompilationEnvironment } from "@/compilation/compilationEnvironment";

function missingPort<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`test_runtime_port_missing:${name}`);
        };
      },
    },
  ) as T;
}

export function createTestApplicationRuntime(
  overrides: Partial<ApplicationRuntime> = {},
): ApplicationRuntime {
  return {
    projects: overrides.projects ?? missingPort("projects"),
    templates: overrides.templates ?? missingPort("templates"),
    workspace: overrides.workspace ?? missingPort("workspace"),
    collaboration: overrides.collaboration ?? missingPort("collaboration"),
    compilation: overrides.compilation ?? createTestCompilationEnvironment(),
  };
}

export function createTestCompilationEnvironment(): CompilationEnvironment {
  return {
    typst: {
      builtinBaseUrl: "https://example.test/typst-builtin/",
      builtinCredentials: "omit",
      packageSource: {
        kind: "preview",
        baseUrl: "https://packages.typst.org",
      },
      runtimeBaseUrl: "https://example.test/typst-runtime/",
      fontAssetsBaseUrl: "https://example.test/vendor/typst-assets/fonts/",
    },
    latex: {
      runtimeBaseUrl: "https://example.test/busytex/",
      texliveBaseUrl: "https://example.test/texlive/",
    },
  };
}
