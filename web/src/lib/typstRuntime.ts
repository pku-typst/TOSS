import runtimeConfig from "../../typst-runtime.config.json";

export type TypstRuntimeModule = {
  url: string;
  sha256: string;
  size_bytes: number;
};

export type TypstRuntimeManifest = {
  schema: 2;
  typst_ts_version: string;
  compiler_package_version: string;
  compiler_source_revision: string;
  renderer_package_version: string;
  compiler: TypstRuntimeModule;
  renderer: TypstRuntimeModule;
};

// The wasm-bindgen glue lives in the application bundle. Key the manifest and
// decoded module cache by every ABI pin so a retained service worker cannot
// pair a new bundle with a previous compiler or renderer binary.
export const TYPST_RUNTIME_BUILD_ID = [
  runtimeConfig.runtime_version,
  runtimeConfig.compiler.package_version,
  runtimeConfig.compiler.source_revision,
  runtimeConfig.renderer.package_version
].join(":");

export const TYPST_RUNTIME_MODULE_CACHE = `typst.runtime.modules.${TYPST_RUNTIME_BUILD_ID}`;

function isRuntimeModule(value: unknown): value is TypstRuntimeModule {
  if (!value || typeof value !== "object") return false;
  const module = value as Partial<TypstRuntimeModule>;
  return (
    typeof module.url === "string" &&
    module.url.startsWith("/typst-runtime/") &&
    typeof module.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(module.sha256) &&
    typeof module.size_bytes === "number" &&
    Number.isSafeInteger(module.size_bytes) &&
    module.size_bytes > 0
  );
}

function parseRuntimeManifest(value: unknown): TypstRuntimeManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Typst runtime manifest is invalid");
  }
  const manifest = value as Partial<TypstRuntimeManifest>;
  if (
    manifest.schema !== 2 ||
    typeof manifest.typst_ts_version !== "string" ||
    !manifest.typst_ts_version ||
    typeof manifest.compiler_package_version !== "string" ||
    !manifest.compiler_package_version ||
    typeof manifest.compiler_source_revision !== "string" ||
    !/^[a-f0-9]{40}$/i.test(manifest.compiler_source_revision) ||
    typeof manifest.renderer_package_version !== "string" ||
    !manifest.renderer_package_version ||
    !isRuntimeModule(manifest.compiler) ||
    !isRuntimeModule(manifest.renderer)
  ) {
    throw new Error("Typst runtime manifest is incomplete");
  }
  if (
    manifest.typst_ts_version !== runtimeConfig.runtime_version ||
    manifest.compiler_package_version !== runtimeConfig.compiler.package_version ||
    manifest.compiler_source_revision !== runtimeConfig.compiler.source_revision ||
    manifest.renderer_package_version !== runtimeConfig.renderer.package_version
  ) {
    throw new Error(
      `Typst runtime manifest is incompatible with this application build: expected ${TYPST_RUNTIME_BUILD_ID}`
    );
  }
  return manifest as TypstRuntimeManifest;
}

export async function loadTypstRuntimeManifest(appOrigin: string): Promise<TypstRuntimeManifest> {
  const url = new URL("/typst-runtime/manifest.json", appOrigin);
  url.searchParams.set("runtime", TYPST_RUNTIME_BUILD_ID);
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error(`Typst runtime manifest fetch failed: ${response.status}`);
  }
  return parseRuntimeManifest(await response.json());
}

export function absoluteRuntimeModuleUrl(module: TypstRuntimeModule, appOrigin: string): string {
  return new URL(module.url, appOrigin).toString();
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyRuntimeModule(
  bytes: ArrayBuffer | Uint8Array,
  module: TypstRuntimeModule,
  label: string
): Promise<void> {
  const size = bytes instanceof Uint8Array ? bytes.byteLength : bytes.byteLength;
  if (size !== module.size_bytes) {
    throw new Error(`${label} size mismatch: expected ${module.size_bytes}, received ${size}`);
  }
  const digest = await sha256Hex(bytes);
  if (digest !== module.sha256.toLowerCase()) {
    throw new Error(`${label} checksum mismatch`);
  }
}
