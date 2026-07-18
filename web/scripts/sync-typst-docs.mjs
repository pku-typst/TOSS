import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(webRoot, "src", "ai-runtime", "typst-docs");
const manifestPath = path.join(outputRoot, "manifest.json");
const recipesPath = path.join(outputRoot, "recipes.json");
const runtimeConfigPath = path.join(webRoot, "typst-runtime.config.json");

const SOURCE_REPOSITORY = "https://github.com/lucifer1004/claude-skill-typst";
const SOURCE_RAW_ROOT = "https://raw.githubusercontent.com/lucifer1004/claude-skill-typst";
const SOURCE_REVISION = "94b0c65944e743b3389d24a1c99736bf92605c72";
const LANGUAGE_VERSION = "0.15.0";
const files = [
  {
    name: "api-0.15.0.json",
    sourcePath: "skills/typst/data/api-0.15.0.json",
    sha256: "4e096de3321c0b5e0b9213a9d39186094e713212cd386c7444862f216b710d59"
  },
  {
    name: "api-0.15.0-bm25.json",
    sourcePath: "skills/typst/data/api-0.15.0-bm25.json",
    sha256: "5a0f7dc54ceb7c99a871b475a96e99429a1cd4ff72226d49993452984b274fbc"
  }
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function verifyLanguageVersion() {
  const runtimeConfig = await readJson(runtimeConfigPath);
  if (runtimeConfig.typst_language_version !== LANGUAGE_VERSION) {
    fail(
      `Typst documentation version ${LANGUAGE_VERSION} does not match ` +
      `typst-runtime.config.json (${runtimeConfig.typst_language_version ?? "missing"})`
    );
  }
}

function validateApi(value) {
  if (!Array.isArray(value) || value.length !== 3_148) {
    fail("The Typst API index has an unexpected entry count");
  }
  const document = value.find((entry) => entry?.name === "document");
  const parameterTypes = Object.fromEntries(
    (document?.params ?? []).map((parameter) => [parameter.name, parameter.types])
  );
  if (
    document?.kind !== "function" ||
    !parameterTypes.title?.includes("content") ||
    !parameterTypes.author?.includes("str") ||
    !parameterTypes.author?.includes("array") ||
    !parameterTypes.keywords?.includes("str") ||
    !parameterTypes.keywords?.includes("array")
  ) {
    fail("The Typst API index lost the expected document metadata contract");
  }
}

function validateBm25(value) {
  if (
    value?.meta?.num_docs !== 3_148 ||
    !Number.isFinite(value?.meta?.avg_dl) ||
    !Number.isFinite(value?.meta?.k1) ||
    !Number.isFinite(value?.meta?.b) ||
    typeof value?.idf !== "object" ||
    typeof value?.postings !== "object" ||
    typeof value?.doc_lengths !== "object"
  ) {
    fail("The Typst BM25 index is invalid");
  }
}

function validateRecipes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("The curated Typst recipes are invalid");
  }
  const ids = new Set();
  for (const recipe of value) {
    const stringFields = ["id", "title", "summary", "example", "sourceRoute"];
    const hasValidStrings = stringFields.every(
      (field) => typeof recipe?.[field] === "string" && recipe[field].trim().length > 0
    );
    const hasValidLists = ["keywords", "notes"].every(
      (field) => Array.isArray(recipe?.[field]) &&
        recipe[field].length > 0 &&
        recipe[field].every((item) => typeof item === "string" && item.trim().length > 0)
    );
    if (
      !hasValidStrings ||
      !hasValidLists ||
      !recipe.sourceRoute.startsWith("/reference/") ||
      ids.has(recipe.id)
    ) {
      fail(`Invalid or duplicate curated Typst recipe: ${recipe?.id ?? "unknown"}`);
    }
    ids.add(recipe.id);
  }
}

async function verifyFile(file) {
  const target = path.join(outputRoot, file.name);
  const bytes = await fs.readFile(target);
  const digest = sha256(bytes);
  if (digest !== file.sha256) {
    fail(`${file.name} checksum mismatch: expected ${file.sha256}, received ${digest}`);
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (file.name.includes("bm25")) validateBm25(parsed);
  else validateApi(parsed);
  return bytes.byteLength;
}

function expectedManifest() {
  return {
    schema: 1,
    typst_language_version: LANGUAGE_VERSION,
    source_repository: SOURCE_REPOSITORY,
    source_revision: SOURCE_REVISION,
    files: Object.fromEntries(files.map((file) => [file.name, {
      source_path: file.sourcePath,
      sha256: file.sha256
    }]))
  };
}

async function verifyManifest() {
  const actual = await readJson(manifestPath);
  if (JSON.stringify(actual) !== JSON.stringify(expectedManifest())) {
    fail("The Typst documentation manifest does not match the pinned sources");
  }
}

async function sync() {
  await fs.mkdir(outputRoot, { recursive: true });
  for (const file of files) {
    const url = `${SOURCE_RAW_ROOT}/${SOURCE_REVISION}/${file.sourcePath}`;
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) fail(`Failed to download ${file.name}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== file.sha256) {
      fail(`${file.name} source checksum mismatch: expected ${file.sha256}, received ${digest}`);
    }
    await fs.writeFile(path.join(outputRoot, file.name), bytes);
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(expectedManifest(), null, 2)}\n`);
}

async function main() {
  const command = process.argv[2] ?? "verify";
  if (command !== "sync" && command !== "verify") {
    fail("Usage: node scripts/sync-typst-docs.mjs <sync|verify>");
  }
  await verifyLanguageVersion();
  if (command === "sync") await sync();
  const sizes = await Promise.all(files.map(verifyFile));
  await verifyManifest();
  validateRecipes(await readJson(recipesPath));
  process.stdout.write(
    `[typst-docs] ${command === "sync" ? "synced" : "verified"} Typst ${LANGUAGE_VERSION} ` +
    `reference (${files.length} files, ${Math.round(sizes.reduce((sum, size) => sum + size, 0) / 1024)} KiB)\n`
  );
}

main().catch((error) => {
  console.error(`[typst-docs] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
