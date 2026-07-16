import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptRoot, "..");
const repoRoot = path.resolve(webRoot, "..");
const sourceRoot = path.join(repoRoot, "prebuilt", "busytex", "package");
const buildManifestPath = path.join(
  repoRoot,
  "prebuilt",
  "busytex",
  "build-manifest.json",
);
const publicRoot = path.join(webRoot, "public", "busytex");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function selectedDistribution() {
  const configured = process.env.TOSS_CONFIG?.trim();
  const configPath = configured
    ? path.resolve(webRoot, configured)
    : path.join(repoRoot, "distributions", "community", "toss.json");
  return readJson(configPath);
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function synchronize() {
  const distribution = await selectedDistribution();
  const projectTypes = distribution?.capabilities?.project_types;
  const latexEnabled =
    Array.isArray(projectTypes) && projectTypes.includes("latex");
  if (!latexEnabled) {
    await fs.rm(publicRoot, { recursive: true, force: true });
    process.stdout.write("[busytex-assets] skipped for Typst-only distribution\n");
    return;
  }

  const manifest = await readJson(buildManifestPath);
  const packageMetadata = await readJson(
    path.join(webRoot, "node_modules", manifest.npm_package, "package.json"),
  );
  if (
    manifest.schema !== 1 ||
    manifest.npm_package !== "texlyre-busytex" ||
    packageMetadata.version !== manifest.npm_package_version ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.revision ?? "") ||
    !manifest.files ||
    typeof manifest.files !== "object"
  ) {
    throw new Error("BusyTeX build manifest does not match the installed runtime");
  }

  const destination = path.join(publicRoot, manifest.runtime_version);
  await fs.rm(publicRoot, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const [filename, expected] of Object.entries(manifest.files)) {
    const source = path.join(sourceRoot, filename);
    const bytes = await fs.readFile(source);
    if (bytes.subarray(0, 40).toString("utf8").startsWith("version https://git-lfs")) {
      throw new Error(`BusyTeX asset is an unhydrated Git LFS pointer: ${filename}`);
    }
    if (
      bytes.byteLength !== expected.size_bytes ||
      (await sha256(source)) !== expected.sha256
    ) {
      throw new Error(`BusyTeX asset failed manifest verification: ${filename}`);
    }
    await fs.copyFile(source, path.join(destination, filename));
  }
  await fs.writeFile(
    path.join(publicRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `[busytex-assets] synced TeX Live ${manifest.texlive_version} runtime ${manifest.runtime_version}\n`,
  );
}

await synchronize();
