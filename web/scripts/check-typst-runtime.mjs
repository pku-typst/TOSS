import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TypstSnippet } from "@myriaddreamin/typst.ts/contrib/snippet";
import { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";
import { loadFonts, withAccessModel, withPackageRegistry } from "@myriaddreamin/typst.ts/options.init";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");

async function loadDistribution() {
  const configuredPath = process.env.TOSS_CONFIG?.trim();
  const configPath = path.resolve(
    process.cwd(),
    configuredPath || path.join(repoRoot, "distributions", "community", "toss.json")
  );
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (config.schema !== 6 || typeof config.id !== "string") {
    throw new Error(`Unsupported distribution config: ${configPath}`);
  }
  const configRoot = path.dirname(configPath);
  const builtinRoot = path.resolve(configRoot, config.typst?.builtin_dir || "");
  const templatePath = path.resolve(
    configRoot,
    config.project_types?.typst?.starter_template || ""
  );
  if (!Array.isArray(config.template_gallery?.builtins)) {
    throw new Error(`Distribution template gallery is missing: ${configPath}`);
  }
  const galleryTemplates = config.template_gallery.builtins
    .filter((template) => template.project_type === "typst")
    .map((template) => {
      const entryFile = safeArchivePath(String(template.entry_file || ""));
      if (!entryFile || typeof template.id !== "string" || typeof template.source_dir !== "string") {
        throw new Error(`Distribution contains an invalid Typst gallery template: ${configPath}`);
      }
      return {
        id: template.id,
        entryFile,
        sourceRoot: path.resolve(configRoot, template.source_dir)
      };
    });
  return {
    id: config.id,
    builtinRoot,
    template: await fs.readFile(templatePath, "utf8"),
    galleryTemplates
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageKey(spec) {
  return `${spec.namespace}/${spec.name}/${spec.version}`;
}

function safeArchivePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function isTemplateTextFile(filePath) {
  return [
    ".typ", ".tex", ".ltx", ".sty", ".cls", ".bst", ".bib", ".txt", ".md", ".json",
    ".toml", ".yaml", ".yml", ".csv", ".xml", ".html", ".css", ".js", ".ts", ".tsx",
    ".jsx"
  ].some((extension) => filePath.toLowerCase().endsWith(extension));
}

async function readTemplateFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Gallery template contains a symlink: ${path.join(relative, entry.name)}`);
    }
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await readTemplateFiles(root, nextRelative)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Gallery template contains an unsupported entry: ${nextRelative}`);
    }
    const safePath = safeArchivePath(nextRelative);
    if (!safePath) throw new Error(`Gallery template contains an unsafe path: ${nextRelative}`);
    files.push({ path: safePath, bytes: new Uint8Array(await fs.readFile(path.join(root, safePath))) });
  }
  return files;
}

async function compileOutputs(compiler, mainFilePath, minimumPdfBytes = 1_000) {
  const result = await compiler.runWithWorld({ mainFilePath }, async (world) => {
    const checked = await world.compile({ diagnostics: "unix" });
    if (checked.hasError) return { diagnostics: checked.diagnostics ?? [] };
    const vector = await world.vector({ diagnostics: "unix" });
    const pdf = await world.pdf({ diagnostics: "unix" });
    return {
      diagnostics: [...(vector.diagnostics ?? []), ...(pdf.diagnostics ?? [])],
      vector: vector.result,
      pdf: pdf.result
    };
  });
  const diagnostics = (result.diagnostics ?? []).map(String).filter(Boolean);
  if (diagnostics.length > 0) {
    throw new Error(`Typst diagnostics for ${mainFilePath}:\n${diagnostics.join("\n")}`);
  }
  if (!result.vector || result.vector.byteLength < 1_000) {
    throw new Error(`Vector output is missing for ${mainFilePath}`);
  }
  if (!result.pdf || result.pdf.byteLength < minimumPdfBytes) {
    throw new Error(`PDF output is missing for ${mainFilePath}`);
  }
  return result;
}

class CheckedPackageRegistry {
  constructor(accessModel, packages) {
    this.accessModel = accessModel;
    this.packages = packages;
    this.resolved = new Map();
  }

  resolve(spec, context) {
    const key = packageKey(spec);
    if (this.resolved.has(key)) return this.resolved.get(key)();
    const bytes = this.packages.get(key);
    if (!bytes) return undefined;
    const base = `/@memory/check/packages/${key}`;
    const files = [];
    context.untar(bytes, (archivePath, data, mtime) => {
      const safePath = safeArchivePath(archivePath);
      if (!safePath) throw new Error(`Unsafe archive path in ${key}: ${archivePath}`);
      files.push([`${base}/${safePath}`, data, new Date(mtime)]);
    });
    const materialize = () => {
      for (const [filePath, data, mtime] of files) this.accessModel.insertFile(filePath, data, mtime);
      return base;
    };
    this.resolved.set(key, materialize);
    return materialize();
  }
}

async function loadCheckedFile(root, entry) {
  const filePath = path.join(root, entry.artifact_path);
  const bytes = new Uint8Array(await fs.readFile(filePath));
  if (bytes.byteLength !== entry.size_bytes) {
    throw new Error(`${entry.artifact_path} size mismatch`);
  }
  if (sha256(bytes) !== entry.sha256) {
    throw new Error(`${entry.artifact_path} checksum mismatch`);
  }
  return bytes;
}

async function loadRuntimeArtifact(manifest, runtimeVersion, name) {
  const entry = manifest[name];
  const expectedRoot = path.resolve(webRoot, "public", "typst-runtime", runtimeVersion);
  if (
    !entry ||
    typeof entry.url !== "string" ||
    typeof entry.sha256 !== "string" ||
    !Number.isSafeInteger(entry.size_bytes) ||
    entry.size_bytes <= 0
  ) {
    throw new Error(`Typst runtime ${name} manifest entry is invalid`);
  }
  const artifactPath = path.resolve(webRoot, "public", entry.url.replace(/^\//, ""));
  if (path.dirname(artifactPath) !== expectedRoot) {
    throw new Error(`Typst runtime ${name} URL does not use runtime ${runtimeVersion}`);
  }
  const bytes = new Uint8Array(await fs.readFile(artifactPath));
  if (bytes.byteLength !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Typst runtime ${name} artifact does not match its manifest`);
  }
  return bytes;
}

async function main() {
  const distribution = await loadDistribution();
  const runtimeConfig = JSON.parse(
    await fs.readFile(path.join(webRoot, "typst-runtime.config.json"), "utf8")
  );
  const runtimeManifest = JSON.parse(
    await fs.readFile(path.join(webRoot, "public", "typst-runtime", "manifest.json"), "utf8")
  );
  if (
    runtimeManifest.schema !== 2 ||
    runtimeManifest.typst_ts_version !== runtimeConfig.runtime_version ||
    runtimeManifest.compiler_source_revision !== runtimeConfig.compiler.source_revision ||
    runtimeManifest.compiler_package_version !== runtimeConfig.compiler.package_version ||
    runtimeManifest.renderer_package_version !== runtimeConfig.renderer.package_version
  ) {
    throw new Error("Typst runtime manifest provenance does not match typst-runtime.config.json");
  }
  const [compilerWasm] = await Promise.all([
    loadRuntimeArtifact(runtimeManifest, runtimeConfig.runtime_version, "compiler"),
    loadRuntimeArtifact(runtimeManifest, runtimeConfig.runtime_version, "renderer")
  ]);
  const builtinRoot = distribution.builtinRoot;
  const catalog = JSON.parse(await fs.readFile(path.join(builtinRoot, "catalog.json"), "utf8"));
  if (
    catalog.schema !== 2 ||
    !Array.isArray(catalog.local_packages) ||
    !Array.isArray(catalog.universe_seeds) ||
    !Array.isArray(catalog.font_bundles)
  ) {
    throw new Error("Unsupported built-in Typst catalog schema");
  }
  const packages = new Map();
  for (const entry of [...catalog.local_packages, ...catalog.universe_seeds]) {
    packages.set(packageKey(entry), await loadCheckedFile(builtinRoot, entry));
  }

  const fontEntries = catalog.font_bundles.flatMap((bundle) => bundle.fonts);
  const fonts = [];
  for (const entry of fontEntries) fonts.push(await loadCheckedFile(builtinRoot, entry));
  const defaultFontRoot = path.join(webRoot, "public", "vendor", "typst-assets", "fonts");
  for (const file of (await fs.readdir(defaultFontRoot)).sort()) {
    if (/\.(otf|ttf)$/i.test(file)) fonts.push(new Uint8Array(await fs.readFile(path.join(defaultFontRoot, file))));
  }

  const accessModel = new MemoryAccessModel();
  const typst = new TypstSnippet();
  typst.setCompilerInitOptions({
    beforeBuild: [
      withAccessModel(accessModel),
      withPackageRegistry(new CheckedPackageRegistry(accessModel, packages)),
      loadFonts(fonts, { assets: false })
    ],
    getModule: () => ({ module_or_path: compilerWasm })
  });
  await typst.addSource("/main.typ", distribution.template);

  const compiler = await typst.getCompiler();
  const startedAt = performance.now();
  const result = await compileOutputs(compiler, "/main.typ", 10_000);

  for (const template of distribution.galleryTemplates) {
    const basePath = `/gallery/${template.id}`;
    const files = await readTemplateFiles(template.sourceRoot);
    if (!files.some((file) => file.path === template.entryFile)) {
      throw new Error(`Gallery template ${template.id} is missing ${template.entryFile}`);
    }
    for (const file of files) {
      const targetPath = `${basePath}/${file.path}`;
      if (isTemplateTextFile(file.path)) {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        await compiler.addSource(targetPath, source);
      } else {
        compiler.mapShadow(targetPath, file.bytes);
      }
    }
    await compileOutputs(compiler, `${basePath}/${template.entryFile}`);
  }

  const mappingPath = "/sync-navigation.typ";
  const mappingSource = [
    "#set page(width: 420pt, height: 220pt, margin: 0pt)",
    "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-FIRST]]",
    "#pagebreak()",
    "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-SECOND]]",
    "#pagebreak()",
    "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-THIRD]]"
  ].join("\n");
  await compiler.addSource(mappingPath, mappingSource);
  await compiler.withIncrementalServer(async (server) => {
    const compiled = await compiler.compile({
      mainFilePath: mappingPath,
      incrementalServer: server,
      diagnostics: "unix"
    });
    if (!compiled.result || compiled.hasError) {
      throw new Error("Incremental mapping fixture did not compile");
    }
    const rawServer = server[Symbol.for("reflexo-obj")];
    if (
      !rawServer ||
      typeof rawServer.mapping_revision !== "number" ||
      typeof rawServer.source_to_document !== "function" ||
      typeof rawServer.document_to_source !== "function"
    ) {
      throw new Error("Forked compiler source mapping API is unavailable");
    }
    const sourceOffset = mappingSource.indexOf("SYNC-THIRD") + 2;
    const positions = rawServer.source_to_document(mappingPath, sourceOffset);
    const position = Array.isArray(positions)
      ? positions.find((candidate) => candidate.pageOffset === 2)
      : undefined;
    if (!position || rawServer.mapping_revision !== 1) {
      throw new Error("Source-to-document mapping did not return the third page position");
    }
    const location = rawServer.document_to_source(
      position.pageOffset,
      position.x + 0.1,
      position.y - 0.1
    );
    if (!location || location.path !== mappingPath || location.package !== undefined) {
      throw new Error("Document-to-source mapping did not round-trip to the fixture");
    }
  });
  process.stdout.write(
    `[typst-runtime-check] ${distribution.id} ok in ${Math.round(performance.now() - startedAt)}ms ` +
      `(vector=${result.vector.byteLength} bytes, pdf=${result.pdf.byteLength} bytes, ` +
      `gallery=${distribution.galleryTemplates.length}, ` +
      `compiler=${runtimeConfig.compiler.source_revision.slice(0, 7)})\n`
  );
}

main().catch((error) => {
  console.error(`[typst-runtime-check] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
