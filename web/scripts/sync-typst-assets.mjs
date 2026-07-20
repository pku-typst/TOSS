import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(webRoot, ".cache", "typst-assets");
const publicFontsRoot = path.join(webRoot, "public", "vendor", "typst-assets", "fonts");
const publicManifestPath = path.join(publicFontsRoot, ".manifest.json");
const publicRuntimeRoot = path.join(webRoot, "public", "typst-runtime");
const publicRuntimeManifestPath = path.join(publicRuntimeRoot, "manifest.json");
const runtimeConfigPath = path.join(webRoot, "typst-runtime.config.json");

const COMPILER_PACKAGE_NAME = "@pku-typst/typst-ts-web-compiler";
const UPSTREAM_COMPILER_PACKAGE_NAME = "@myriaddreamin/typst-ts-web-compiler";
const RENDERER_PACKAGE_NAME = "@myriaddreamin/typst-ts-renderer";
const DEFAULT_TYPST_ASSETS_TAG = "v0.15.0";
const upstreamCompilerVersionToAssetsTag = {
  "0.8.0-rc3": "v0.15.0"
};

const textFonts = [
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono.ttf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-BoldItalic.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Semibold.otf",
  "LibertinusSerif-SemiboldItalic.otf",
  "NewCM10-Bold.otf",
  "NewCM10-BoldItalic.otf",
  "NewCM10-Italic.otf",
  "NewCM10-Regular.otf",
  "NewCMMath-Bold.otf",
  "NewCMMath-Book.otf",
  "NewCMMath-Regular.otf"
];

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hashList(values) {
  const hasher = createHash("sha256");
  for (const value of values) hasher.update(value).update("\n");
  return hasher.digest("hex");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function packageMetadata(packageName) {
  const packageJsonPath = path.join(webRoot, "node_modules", ...packageName.split("/"), "package.json");
  return readJson(packageJsonPath);
}

function isSafeHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function loadRuntimeConfig() {
  const config = await readJson(runtimeConfigPath);
  const expectedBrowserUrl =
    `https://cdn.jsdelivr.net/npm/${config.compiler?.package}@${config.compiler?.package_version}` +
    "/pkg/typst_ts_web_compiler_bg.wasm";
  if (
    config.schema !== 1 ||
    config.typst_language_version !== "0.15.0" ||
    typeof config.runtime_version !== "string" ||
    !config.runtime_version ||
    config.compiler?.package !== COMPILER_PACKAGE_NAME ||
    typeof config.compiler?.package_version !== "string" ||
    config.compiler?.upstream_package !== UPSTREAM_COMPILER_PACKAGE_NAME ||
    typeof config.compiler?.upstream_package_version !== "string" ||
    !/^[a-f0-9]{40}$/i.test(config.compiler?.source_revision || "") ||
    !isSafeHttpsUrl(config.compiler?.browser_url) ||
    config.compiler?.browser_url !== expectedBrowserUrl ||
    config.renderer?.package !== RENDERER_PACKAGE_NAME ||
    typeof config.renderer?.package_version !== "string"
  ) {
    throw new Error(`Invalid Typst runtime config: ${runtimeConfigPath}`);
  }
  return config;
}

async function verifyCompilerPackageProvenance(runtimeConfig, compiler) {
  if (
    compiler.toss?.sourceRevision !== runtimeConfig.compiler.source_revision ||
    compiler.toss?.upstreamPackage !== runtimeConfig.compiler.upstream_package ||
    compiler.toss?.upstreamVersion !== runtimeConfig.compiler.upstream_package_version
  ) {
    throw new Error("Installed compiler package provenance does not match Typst runtime config");
  }
  const compilerTypesPath = path.join(
    webRoot,
    "node_modules",
    ...COMPILER_PACKAGE_NAME.split("/"),
    "pkg",
    "typst_ts_web_compiler.d.ts"
  );
  const compilerTypes = await fs.readFile(compilerTypesPath, "utf8");
  for (const symbol of ["mapping_revision", "source_to_document", "document_to_source"]) {
    if (!compilerTypes.includes(symbol)) {
      throw new Error(
        `Forked compiler package is stale: ${symbol} is missing`
      );
    }
  }
}

async function detectTypstAssetsTag() {
  const envOverride = process.env.TYPST_ASSETS_TAG?.trim();
  if (envOverride) return envOverride;
  const packageJsonPath = path.join(webRoot, "node_modules", ...COMPILER_PACKAGE_NAME.split("/"), "package.json");
  try {
    const packageJson = await readJson(packageJsonPath);
    const upstreamVersion = String(packageJson.toss?.upstreamVersion || "").trim();
    if (upstreamVersion && upstreamCompilerVersionToAssetsTag[upstreamVersion]) {
      return upstreamCompilerVersionToAssetsTag[upstreamVersion];
    }
    process.stdout.write(
      `[typst-assets] no mapped assets tag for upstream compiler ${upstreamVersion || "unknown"}, fallback ${DEFAULT_TYPST_ASSETS_TAG}\n`
    );
  } catch {
    process.stdout.write(
      `[typst-assets] compiler package metadata missing, fallback ${DEFAULT_TYPST_ASSETS_TAG}\n`
    );
  }
  return DEFAULT_TYPST_ASSETS_TAG;
}

async function syncRuntimeModules() {
  const runtimeConfig = await loadRuntimeConfig();
  const compiler = await packageMetadata(COMPILER_PACKAGE_NAME);
  const renderer = await packageMetadata(RENDERER_PACKAGE_NAME);
  await verifyCompilerPackageProvenance(runtimeConfig, compiler);
  const compilerVersion = String(compiler.version || "").trim();
  const rendererVersion = String(renderer.version || "").trim();
  if (
    !compilerVersion ||
    runtimeConfig.compiler.upstream_package_version !== rendererVersion
  ) {
    throw new Error(
      `Typst compiler ABI/renderer versions must match ` +
        `(compiler=${runtimeConfig.compiler.upstream_package_version}, renderer=${rendererVersion || "missing"})`
    );
  }
  if (
    compilerVersion !== runtimeConfig.compiler.package_version ||
    rendererVersion !== runtimeConfig.renderer.package_version
  ) {
    throw new Error(
      `Typst runtime config does not match installed packages ` +
        `(compiler=${compilerVersion}, renderer=${rendererVersion})`
    );
  }

  const webTarget = process.env.TOSS_WEB_TARGET?.trim() || "core";
  if (webTarget !== "core" && webTarget !== "browser") {
    throw new Error(`Invalid TOSS_WEB_TARGET: ${webTarget}`);
  }
  const versionRoot = path.join(publicRuntimeRoot, runtimeConfig.runtime_version);
  await fs.rm(versionRoot, { recursive: true, force: true });
  await ensureDir(versionRoot);
  const compilerSource = path.join(
    webRoot,
    "node_modules",
    ...COMPILER_PACKAGE_NAME.split("/"),
    "pkg",
    "typst_ts_web_compiler_bg.wasm"
  );
  const rendererSource = path.join(
    webRoot,
    "node_modules",
    ...RENDERER_PACKAGE_NAME.split("/"),
    "pkg",
    "typst_ts_renderer_bg.wasm"
  );
  const compilerFile = "typst_ts_web_compiler_bg.wasm";
  const rendererFile = "typst_ts_renderer_bg.wasm";
  const [compilerSha256, rendererSha256, compilerStat, rendererStat] = await Promise.all([
    sha256File(compilerSource),
    sha256File(rendererSource),
    fs.stat(compilerSource),
    fs.stat(rendererSource)
  ]);
  const compilerUrl = `${runtimeConfig.runtime_version}/${compilerSha256}/${compilerFile}`;
  const rendererUrl = `${runtimeConfig.runtime_version}/${rendererSha256}/${rendererFile}`;
  const compilerDest = path.join(publicRuntimeRoot, compilerUrl);
  const rendererDest = path.join(publicRuntimeRoot, rendererUrl);
  await ensureDir(path.dirname(rendererDest));
  await fs.copyFile(rendererSource, rendererDest);
  if (webTarget === "core") {
    await ensureDir(path.dirname(compilerDest));
    await fs.copyFile(compilerSource, compilerDest);
  }

  const manifest = {
    schema: 2,
    typst_ts_version: runtimeConfig.runtime_version,
    compiler_package_version: compilerVersion,
    compiler_upstream_package_version: runtimeConfig.compiler.upstream_package_version,
    compiler_source_revision: runtimeConfig.compiler.source_revision,
    renderer_package_version: rendererVersion,
    compiler: {
      url:
        webTarget === "browser"
          ? runtimeConfig.compiler.browser_url
          : compilerUrl,
      sha256: compilerSha256,
      size_bytes: compilerStat.size
    },
    renderer: {
      url: rendererUrl,
      sha256: rendererSha256,
      size_bytes: rendererStat.size
    }
  };
  await ensureDir(publicRuntimeRoot);
  await fs.writeFile(publicRuntimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `[typst-assets] synced ${webTarget} runtime ${runtimeConfig.runtime_version} to public/typst-runtime\n`
  );
}

async function readManifestIfAny() {
  if (!(await fileExists(publicManifestPath))) return null;
  try {
    const manifest = await readJson(publicManifestPath);
    if (!manifest || typeof manifest !== "object") return null;
    return manifest;
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  await fs.writeFile(publicManifestPath, JSON.stringify(manifest, null, 2));
}

async function downloadToFile(url, outFile) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await fs.writeFile(outFile, bytes);
      return;
    }
    if (response.status !== 429 || attempt === maxAttempts) {
      throw new Error(`Download failed: ${url} (${response.status})`);
    }
    const waitMs = attempt * 800;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function syncFont(typstAssetsTag, fontFile) {
  const versionedCacheDir = path.join(cacheRoot, typstAssetsTag, "files", "fonts");
  await ensureDir(versionedCacheDir);
  await ensureDir(publicFontsRoot);

  const cachedFile = path.join(versionedCacheDir, fontFile);
  if (!(await fileExists(cachedFile))) {
    const remoteFontBase = `https://raw.githubusercontent.com/typst/typst-assets/${typstAssetsTag}/files/fonts/`;
    const url = `${remoteFontBase}${fontFile}`;
    process.stdout.write(`[typst-assets] download ${fontFile}\n`);
    await downloadToFile(url, cachedFile);
  }

  const dest = path.join(publicFontsRoot, fontFile);
  await fs.copyFile(cachedFile, dest);
}

async function main() {
  await syncRuntimeModules();
  const typstAssetsTag = await detectTypstAssetsTag();
  const fontsHash = hashList(textFonts);
  const existingManifest = await readManifestIfAny();
  if (
    existingManifest &&
    existingManifest.typst_assets_tag === typstAssetsTag &&
    existingManifest.fonts_hash === fontsHash
  ) {
    const allPresent = await Promise.all(
      textFonts.map((font) => fileExists(path.join(publicFontsRoot, font)))
    );
    if (allPresent.every(Boolean)) {
      process.stdout.write(
        `[typst-assets] already synced (tag ${typstAssetsTag}, ${textFonts.length} fonts)\n`
      );
      return;
    }
  }
  for (const font of textFonts) {
    await syncFont(typstAssetsTag, font);
  }
  await writeManifest({
    typst_assets_tag: typstAssetsTag,
    fonts_hash: fontsHash,
    font_count: textFonts.length,
    generated_at: new Date().toISOString(),
    source: COMPILER_PACKAGE_NAME
  });
  process.stdout.write(
    `[typst-assets] synced ${textFonts.length} text font assets (tag ${typstAssetsTag}) to public/vendor/typst-assets/fonts\n`
  );
}

main().catch((error) => {
  console.error(`[typst-assets] sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
