/// <reference lib="webworker" />

import {
  isAiTypstPackageToolName,
  isAiWorkspaceToolArguments,
  type AiTypstPackageToolRequest,
  type AiWorkspaceToolExecution,
  type AiWorkspaceToolResult
} from "@/features/ai/toolContract";
import {
  fetchTypstPackage,
  listTypstPackageFiles,
  readTypstPackageFile,
  searchTypstPackageText,
  TypstPackageInspectionError,
  type LoadedTypstPackage
} from "@/features/ai/typstPackageArchive";
import type {
  TypstPackageInspectorRequest,
  TypstPackageInspectorResponse
} from "@/features/ai/typstPackageInspectorProtocol";

const MAX_CACHED_PACKAGES = 3;
const MAX_CACHED_PACKAGE_BYTES = 128 * 1024 * 1024;
const packages = new Map<string, LoadedTypstPackage>();
const controllers = new Map<number, AbortController>();

function success(result: AiWorkspaceToolResult): AiWorkspaceToolExecution {
  return { outcome: "success", result };
}

function failure(error: unknown): AiWorkspaceToolExecution {
  if (error instanceof TypstPackageInspectionError) {
    return { outcome: "error", error: { code: error.code, message: error.message } };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      outcome: "error",
      error: {
        code: "workspace_request_cancelled",
        message: "The Typst package inspection was cancelled."
      }
    };
  }
  return {
    outcome: "error",
    error: {
      code: "typst_package_internal_error",
      message: "The Typst package could not be inspected safely."
    }
  };
}

function cacheKey(baseUrl: string, packageSpec: string) {
  return `${baseUrl.replace(/\/$/, "")}\n${packageSpec}`;
}

async function loadPackage(
  baseUrl: string,
  packageSpec: string,
  signal: AbortSignal
) {
  const key = cacheKey(baseUrl, packageSpec);
  const cached = packages.get(key);
  if (cached) {
    packages.delete(key);
    packages.set(key, cached);
    return cached;
  }
  const loaded = await fetchTypstPackage(baseUrl, packageSpec, signal);
  packages.delete(key);
  packages.set(key, loaded);
  let cachedBytes = [...packages.values()].reduce(
    (total, pkg) => total + pkg.memoryBytes,
    0
  );
  while (
    packages.size > 1 &&
    (packages.size > MAX_CACHED_PACKAGES || cachedBytes > MAX_CACHED_PACKAGE_BYTES)
  ) {
    const oldest = packages.keys().next().value;
    if (typeof oldest !== "string") break;
    cachedBytes -= packages.get(oldest)?.memoryBytes ?? 0;
    packages.delete(oldest);
  }
  return loaded;
}

async function execute(
  baseUrl: string,
  request: AiTypstPackageToolRequest,
  signal: AbortSignal
) {
  if (
    !isAiTypstPackageToolName(request.tool) ||
    !isAiWorkspaceToolArguments(request.tool, request.arguments)
  ) {
    return failure(new TypstPackageInspectionError(
      "workspace_invalid_arguments",
      "The Typst package tool arguments are invalid."
    ));
  }
  const pkg = await loadPackage(baseUrl, request.arguments.package_spec, signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (request.tool === "list_typst_package_files") {
    return success(listTypstPackageFiles(pkg, request.arguments));
  }
  if (request.tool === "read_typst_package_file") {
    return success(readTypstPackageFile(pkg, request.arguments));
  }
  return success(searchTypstPackageText(pkg, request.arguments, signal));
}

self.addEventListener("message", (event: MessageEvent<TypstPackageInspectorRequest>) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.kind === "cancel") {
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    controllers.get(message.id)?.abort();
    return;
  }
  if (
    message.kind !== "execute" ||
    !Number.isSafeInteger(message.id) ||
    message.id < 1 ||
    typeof message.baseUrl !== "string" ||
    message.baseUrl.length > 2_048 ||
    controllers.has(message.id)
  ) return;
  const controller = new AbortController();
  controllers.set(message.id, controller);
  void execute(message.baseUrl, message.request, controller.signal)
    .catch(failure)
    .then((execution) => {
      const response: TypstPackageInspectorResponse = { id: message.id, execution };
      self.postMessage(response);
    })
    .finally(() => {
      controllers.delete(message.id);
    });
});
