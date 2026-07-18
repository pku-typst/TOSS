import type {
  PackageRegistry,
  PackageResolveContext,
  PackageSpec
} from "@myriaddreamin/typst.ts/internal.types";
import type { WritableAccessModel } from "@/lib/typstBuiltin";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4096;
const FAILURE_RETRY_MS = 10_000;

export type TypstPackageStatus = {
  phase: "downloading" | "complete";
  packageSpec: string;
};

export type TypstPackageResponse = {
  bytes: Uint8Array;
};

export type TypstPackageRequester = (spec: PackageSpec) => TypstPackageResponse;

export type TypstPackageSource =
  | {
      kind: "toss";
      baseUrl: string;
      withCredentials: boolean;
    }
  | {
      kind: "preview";
      baseUrl: string;
    };

function packageSpecLabel(spec: PackageSpec): string {
  return `@${spec.namespace}/${spec.name}:${spec.version}`;
}

function safeArchivePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function decodeErrorBody(response: unknown): string {
  if (!(response instanceof ArrayBuffer) || response.byteLength === 0) return "";
  return new TextDecoder().decode(response).trim().slice(0, 240);
}

function packageError(status: number, spec: PackageSpec, detail: string): Error {
  const label = packageSpecLabel(spec);
  if (status === 401) {
    return new Error(`Cannot download ${label}: your login session has expired`);
  }
  if (status === 404) {
    return new Error(`Typst package ${label} was not found`);
  }
  if (status === 413) {
    return new Error(`Typst package ${label} exceeds the platform size limit`);
  }
  const suffix = detail ? `: ${detail}` : "";
  return new Error(`Cannot download Typst package ${label} (HTTP ${status || "network error"})${suffix}`);
}

function packageUrl(source: TypstPackageSource, spec: PackageSpec) {
  const baseUrl = source.baseUrl.replace(/\/$/, "");
  if (source.kind === "preview") {
    if (spec.namespace !== "preview") {
      throw new Error(`Typst package ${packageSpecLabel(spec)} is not available from the preview registry`);
    }
    return `${baseUrl}/preview/${encodeURIComponent(spec.name)}-${encodeURIComponent(spec.version)}.tar.gz`;
  }
  return `${baseUrl}/${encodeURIComponent(spec.namespace)}/${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}`;
}

export function createHttpTypstPackageRequester(
  source: TypstPackageSource,
): TypstPackageRequester {
  return (spec) => {
    const url = packageUrl(source, spec);
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.responseType = "arraybuffer";
    request.withCredentials = source.kind === "toss" && source.withCredentials;
    try {
      request.send(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network request failed";
      throw packageError(0, spec, detail);
    }
    if (request.status !== 200) {
      throw packageError(request.status, spec, decodeErrorBody(request.response));
    }
    if (!(request.response instanceof ArrayBuffer)) {
      throw new Error(`Typst package ${packageSpecLabel(spec)} returned an invalid response`);
    }
    const bytes = new Uint8Array(request.response);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Typst package ${packageSpecLabel(spec)} returned an invalid archive size`);
    }
    return { bytes };
  };
}

export class UniversePackageRegistry implements PackageRegistry {
  private readonly resolved = new Map<string, () => string>();
  private readonly failures = new Map<string, { retryAt: number; message: string }>();

  constructor(
    private readonly accessModel: WritableAccessModel,
    private readonly requestPackage: TypstPackageRequester,
    private readonly onStatus?: (status: TypstPackageStatus) => void
  ) {}

  resolve(spec: PackageSpec, context: PackageResolveContext): string | undefined {
    if (spec.namespace !== "preview") return undefined;
    const label = packageSpecLabel(spec);
    const cached = this.resolved.get(label);
    if (cached) return cached();
    const failure = this.failures.get(label);
    if (failure && failure.retryAt > Date.now()) throw new Error(failure.message);
    this.failures.delete(label);

    this.onStatus?.({ phase: "downloading", packageSpec: label });
    try {
      const { bytes } = this.requestPackage(spec);
      const basePath = `/@memory/universe/packages/${spec.namespace}/${spec.name}/${spec.version}`;
      const files: Array<{ path: string; data: Uint8Array; mtime: Date }> = [];
      let extractedBytes = 0;
      let hasManifest = false;
      context.untar(bytes, (archivePath, data, mtime) => {
        const safePath = safeArchivePath(archivePath);
        if (!safePath) throw new Error(`Unsafe path in ${label}: ${archivePath}`);
        if (data.byteLength > MAX_FILE_BYTES) {
          throw new Error(`Typst package ${label} contains an oversized file: ${safePath}`);
        }
        extractedBytes += data.byteLength;
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error(`Typst package ${label} exceeds the extracted size limit`);
        }
        if (files.length >= MAX_FILES) {
          throw new Error(`Typst package ${label} contains too many files`);
        }
        if (safePath === "typst.toml") hasManifest = true;
        files.push({ path: `${basePath}/${safePath}`, data, mtime: new Date(mtime) });
      });
      if (!hasManifest) throw new Error(`Typst package ${label} is missing typst.toml`);

      const materialize = () => {
        for (const file of files) this.accessModel.insertFile(file.path, file.data, file.mtime);
        return basePath;
      };
      this.resolved.set(label, materialize);
      this.failures.delete(label);
      return materialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(label, { retryAt: Date.now() + FAILURE_RETRY_MS, message });
      throw error;
    } finally {
      this.onStatus?.({ phase: "complete", packageSpec: label });
    }
  }
}

export class HybridPackageRegistry implements PackageRegistry {
  constructor(
    private readonly local: PackageRegistry,
    private readonly universe: PackageRegistry
  ) {}

  resolve(spec: PackageSpec, context: PackageResolveContext): string | undefined {
    return this.local.resolve(spec, context) ?? this.universe.resolve(spec, context);
  }
}

export function createHybridPackageRegistry(options: {
  local: PackageRegistry;
  accessModel: WritableAccessModel;
  source: TypstPackageSource;
  onStatus?: (status: TypstPackageStatus) => void;
}): PackageRegistry {
  const universe = new UniversePackageRegistry(
    options.accessModel,
    createHttpTypstPackageRequester(options.source),
    options.onStatus
  );
  return new HybridPackageRegistry(options.local, universe);
}
