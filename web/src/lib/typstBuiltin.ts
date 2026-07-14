import type {
  PackageRegistry,
  PackageResolveContext,
  PackageSpec
} from "@myriaddreamin/typst.ts/internal.types";
import { sha256Hex } from "@/lib/typstRuntime";

export type CatalogPackage = {
  namespace: string;
  name: string;
  version: string;
  artifact_path: string;
  sha256: string;
  size_bytes: number;
};

type BuiltinFont = {
  file: string;
  artifact_path: string;
  sha256: string;
  size_bytes: number;
};

type BuiltinFontBundle = {
  name: string;
  version: string;
  fonts: BuiltinFont[];
};

export type BuiltinTypstCatalog = {
  schema: 2;
  local_packages: CatalogPackage[];
  universe_seeds: CatalogPackage[];
  font_bundles: BuiltinFontBundle[];
};

export type WritableAccessModel = {
  insertFile(path: string, data: Uint8Array, mtime: Date): void;
};

type LoadedPackage = CatalogPackage & {
  bytes: Uint8Array;
};

export type LoadedBuiltinTypst = {
  catalog: BuiltinTypstCatalog;
  cacheKey: string;
  fontUrlsForProfile(profile: BuiltinFontProfile): string[];
  fontFetcher: typeof fetch;
  createLocalPackageRegistry(accessModel: WritableAccessModel): PackageRegistry;
};

export type BuiltinFontProfile = "latin" | "cjk";

function packageKey(spec: Pick<PackageSpec, "namespace" | "name" | "version">): string {
  return `${spec.namespace}/${spec.name}/${spec.version}`;
}

function isSafeArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/")) return false;
  return value.split("/").every((part) => !!part && part !== "." && part !== "..");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCatalog(value: unknown): BuiltinTypstCatalog {
  if (!value || typeof value !== "object") throw new Error("Built-in Typst catalog is invalid");
  const catalog = value as Partial<BuiltinTypstCatalog>;
  if (
    catalog.schema !== 2 ||
    !Array.isArray(catalog.local_packages) ||
    !Array.isArray(catalog.universe_seeds) ||
    !Array.isArray(catalog.font_bundles)
  ) {
    throw new Error("Built-in Typst catalog is incomplete");
  }
  for (const entry of [...catalog.local_packages, ...catalog.universe_seeds]) {
    if (
      !entry ||
      typeof entry.namespace !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      !isSafeArtifactPath(entry.artifact_path) ||
      !isDigest(entry.sha256) ||
      !isSize(entry.size_bytes)
    ) {
      throw new Error("Built-in Typst catalog contains an invalid package");
    }
  }
  if (catalog.local_packages.some((entry) => entry.namespace !== "local")) {
    throw new Error("Built-in Typst catalog local_packages must use the local namespace");
  }
  if (catalog.universe_seeds.some((entry) => entry.namespace !== "preview")) {
    throw new Error("Built-in Typst catalog universe_seeds must use the preview namespace");
  }
  for (const bundle of catalog.font_bundles) {
    if (!bundle || typeof bundle.name !== "string" || typeof bundle.version !== "string" || !Array.isArray(bundle.fonts)) {
      throw new Error("Built-in Typst catalog contains an invalid font bundle");
    }
    for (const font of bundle.fonts) {
      if (
        !font ||
        typeof font.file !== "string" ||
        !isSafeArtifactPath(font.artifact_path) ||
        !isDigest(font.sha256) ||
        !isSize(font.size_bytes)
      ) {
        throw new Error("Built-in Typst catalog contains an invalid font");
      }
    }
  }
  return catalog as BuiltinTypstCatalog;
}

function builtinAssetUrl(baseUrl: string, artifactPath: string): string {
  const base = `${baseUrl.replace(/\/$/, "")}/v1/typst/builtin/`;
  return new URL(artifactPath, base).toString();
}

function isCjkFont(font: BuiltinFont) {
  return /(?:^|[-_])(?:noto)?sanscjk|noto\s*sans\s*cjk/i.test(font.file);
}

async function fetchVerifiedAsset(
  url: string,
  expectedSize: number,
  expectedSha256: string,
  label: string
): Promise<{ bytes: Uint8Array; response: Response }> {
  const response = await fetch(url, {
    cache: "force-cache",
    credentials: "include"
  });
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, received ${bytes.byteLength}`);
  }
  if ((await sha256Hex(bytes)) !== expectedSha256.toLowerCase()) {
    throw new Error(`${label} checksum mismatch`);
  }
  return { bytes, response };
}

function safeArchivePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

class LocalPackageRegistry implements PackageRegistry {
  private readonly packages: Map<string, LoadedPackage>;
  private readonly accessModel: WritableAccessModel;
  private readonly resolved = new Map<string, () => string>();

  constructor(accessModel: WritableAccessModel, packages: LoadedPackage[]) {
    this.accessModel = accessModel;
    this.packages = new Map(packages.map((entry) => [packageKey(entry), entry]));
  }

  resolve(spec: PackageSpec, context: PackageResolveContext): string | undefined {
    const key = packageKey(spec);
    const cached = this.resolved.get(key);
    if (cached) return cached();
    const entry = this.packages.get(key);
    if (!entry) return undefined;

    const basePath = `/@memory/builtin/packages/${spec.namespace}/${spec.name}/${spec.version}`;
    const files: Array<{ path: string; data: Uint8Array; mtime: Date }> = [];
    context.untar(entry.bytes, (archivePath, data, mtime) => {
      const safePath = safeArchivePath(archivePath);
      if (!safePath) throw new Error(`Unsafe path in ${key}: ${archivePath}`);
      files.push({ path: `${basePath}/${safePath}`, data, mtime: new Date(mtime) });
    });
    const materialize = () => {
      for (const file of files) this.accessModel.insertFile(file.path, file.data, file.mtime);
      return basePath;
    };
    this.resolved.set(key, materialize);
    return materialize();
  }
}

export async function loadBuiltinTypst(baseUrl: string): Promise<LoadedBuiltinTypst> {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const catalogUrl = `${normalizedBaseUrl}/v1/typst/builtin/catalog.json`;
  const catalogResponse = await fetch(catalogUrl, {
    cache: "no-store",
    credentials: "include"
  });
  if (!catalogResponse.ok) {
    throw new Error(`Built-in Typst catalog fetch failed: ${catalogResponse.status}`);
  }
  const catalog = parseCatalog(await catalogResponse.json());
  const loadedPackages = await Promise.all(
    catalog.local_packages.map(async (entry) => {
      const url = builtinAssetUrl(normalizedBaseUrl, entry.artifact_path);
      const { bytes } = await fetchVerifiedAsset(
        url,
        entry.size_bytes,
        entry.sha256,
        `@${entry.namespace}/${entry.name}:${entry.version}`
      );
      return { ...entry, bytes };
    })
  );

  const fonts = catalog.font_bundles.flatMap((bundle) => bundle.fonts);
  const fontByUrl = new Map(
    fonts.map((font) => [builtinAssetUrl(normalizedBaseUrl, font.artifact_path), font] as const)
  );
  const fontFetcher: typeof fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const entry = fontByUrl.get(requestUrl);
    if (!entry) return fetch(input, init);
    const { bytes, response } = await fetchVerifiedAsset(
      requestUrl,
      entry.size_bytes,
      entry.sha256,
      `font ${entry.file}`
    );
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };

  const cacheKey = catalog.local_packages
    .map((entry) => `${packageKey(entry)}:${entry.sha256}`)
    .concat(catalog.universe_seeds.map((entry) => `seed:${packageKey(entry)}:${entry.sha256}`))
    .concat(fonts.map((entry) => `${entry.artifact_path}:${entry.sha256}`))
    .join("|");
  return {
    catalog,
    cacheKey,
    fontUrlsForProfile: (profile) =>
      fonts
        .filter((font) => profile === "cjk" || !isCjkFont(font))
        .map((font) => builtinAssetUrl(normalizedBaseUrl, font.artifact_path)),
    fontFetcher,
    createLocalPackageRegistry: (accessModel) => new LocalPackageRegistry(accessModel, loadedPackages)
  };
}
