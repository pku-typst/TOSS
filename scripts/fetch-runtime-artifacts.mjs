#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compilerRoot = path.join(root, "prebuilt", "typst-compiler");
const busytexRoot = path.join(root, "prebuilt", "busytex");

function fail(message) {
  throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return hasher.digest("hex");
}

async function verifyFile(filePath, expected, label) {
  if (
    !expected ||
    !Number.isSafeInteger(expected.size_bytes) ||
    expected.size_bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256 ?? "")
  ) {
    fail(`${label} has invalid provenance metadata`);
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }
  return (
    stat.isFile() &&
    stat.size === expected.size_bytes &&
    (await sha256File(filePath)) === expected.sha256
  );
}

async function listFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      fail(`Runtime artifact contains a non-file entry: ${relative}`);
    }
  }
  return files;
}

async function verifyDirectory(directory, expectedFiles, label) {
  if (!(await exists(directory))) return false;
  let actualFiles;
  try {
    actualFiles = (await listFiles(directory)).sort();
  } catch {
    return false;
  }
  const expectedNames = Object.keys(expectedFiles).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedNames)) return false;
  for (const filename of expectedNames) {
    if (
      !(await verifyFile(
        path.join(directory, filename),
        expectedFiles[filename],
        `${label}/${filename}`,
      ))
    ) {
      return false;
    }
  }
  return true;
}

async function download(url, destination, expected, label) {
  if (!url.startsWith("https://github.com/")) {
    fail(`${label} must use an HTTPS GitHub release URL`);
  }
  const partial = `${destination}.part`;
  await fs.rm(partial, { force: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      process.stdout.write(`[runtime-artifacts] download ${label} (attempt ${attempt})\n`);
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
      if (!(await verifyFile(partial, expected, label))) {
        throw new Error("size or SHA-256 mismatch");
      }
      await fs.rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(partial, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  fail(`Failed to download ${label}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function replaceDirectory(source, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

async function fetchCompiler() {
  const [buildManifest, artifactManifest] = await Promise.all([
    readJson(path.join(compilerRoot, "build-manifest.json")),
    readJson(path.join(compilerRoot, "artifact.json")),
  ]);
  const releaseUrl =
    typeof artifactManifest.source_repository === "string" &&
    typeof artifactManifest.release_tag === "string" &&
    typeof artifactManifest.asset_name === "string"
      ? `${artifactManifest.source_repository.replace(/\/$/, "")}/releases/download/${encodeURIComponent(artifactManifest.release_tag)}/${encodeURIComponent(artifactManifest.asset_name)}`
      : "";
  if (
    buildManifest.schema !== 1 ||
    artifactManifest.schema !== 1 ||
    artifactManifest.source_revision !== buildManifest.source_revision ||
    !artifactManifest.source_repository?.startsWith("https://github.com/") ||
    artifactManifest.url !== releaseUrl ||
    artifactManifest.archive_root !== "package"
  ) {
    fail("Typst compiler artifact provenance is invalid");
  }
  const packageRoot = path.join(compilerRoot, "package");
  if (await verifyDirectory(packageRoot, buildManifest.files, "typst-compiler")) {
    process.stdout.write("[runtime-artifacts] Typst compiler already verified\n");
    return;
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toss-compiler-fetch-"));
  try {
    const archive = path.join(temporaryRoot, "compiler.tar.gz");
    await download(
      artifactManifest.url,
      archive,
      artifactManifest.archive,
      "Typst compiler archive",
    );
    const extracted = path.join(temporaryRoot, "extracted");
    await fs.mkdir(extracted);
    await execFileAsync("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"]);
    const extractedPackage = path.join(extracted, artifactManifest.archive_root);
    if (!(await verifyDirectory(extractedPackage, buildManifest.files, "typst-compiler"))) {
      fail("Extracted Typst compiler package does not match its build manifest");
    }
    await replaceDirectory(extractedPackage, packageRoot);
    process.stdout.write("[runtime-artifacts] hydrated fork-built Typst compiler\n");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function githubReleaseBase(source) {
  if (
    typeof source?.repository !== "string" ||
    !source.repository.startsWith("https://github.com/") ||
    typeof source.release_tag !== "string" ||
    !source.release_tag
  ) {
    fail("BusyTeX release provenance is invalid");
  }
  const repository = source.repository.replace(/\.git$/, "").replace(/\/$/, "");
  return `${repository}/releases/download/${encodeURIComponent(source.release_tag)}`;
}

async function fetchBusytex() {
  const manifest = await readJson(path.join(busytexRoot, "build-manifest.json"));
  if (manifest.schema !== 1 || !manifest.files || typeof manifest.files !== "object") {
    fail("BusyTeX build manifest is invalid");
  }
  const packageRoot = path.join(busytexRoot, "package");
  if (await verifyDirectory(packageRoot, manifest.files, "busytex")) {
    process.stdout.write("[runtime-artifacts] BusyTeX already verified\n");
    return;
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "toss-busytex-fetch-"));
  try {
    const temporaryPackage = path.join(temporaryRoot, "package");
    await fs.mkdir(temporaryPackage);
    const base = githubReleaseBase(manifest.source);
    await Promise.all(
      Object.entries(manifest.files).map(([filename, expected]) =>
        download(
          `${base}/${encodeURIComponent(filename)}`,
          path.join(temporaryPackage, filename),
          expected,
          `BusyTeX ${filename}`,
        ),
      ),
    );
    if (!(await verifyDirectory(temporaryPackage, manifest.files, "busytex"))) {
      fail("Downloaded BusyTeX package does not match its build manifest");
    }
    await replaceDirectory(temporaryPackage, packageRoot);
    process.stdout.write("[runtime-artifacts] hydrated BusyTeX release assets\n");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function selectedDistributionEnablesLatex() {
  const configured = process.env.TOSS_CONFIG?.trim();
  const configPath = configured
    ? path.resolve(process.cwd(), configured)
    : path.join(root, "distributions", "community", "toss.json");
  const distribution = await readJson(configPath);
  const projectTypes = distribution?.capabilities?.project_types;
  if (!Array.isArray(projectTypes)) fail(`Invalid distribution capabilities: ${configPath}`);
  return projectTypes.includes("latex");
}

const command = process.argv[2] ?? "all";
try {
  if (command === "all") {
    await fetchCompiler();
    if (await selectedDistributionEnablesLatex()) {
      await fetchBusytex();
    } else {
      process.stdout.write("[runtime-artifacts] BusyTeX skipped for Typst-only distribution\n");
    }
  }
  if (command === "typst") await fetchCompiler();
  if (command === "busytex") await fetchBusytex();
  if (!new Set(["all", "typst", "busytex"]).has(command)) {
    fail("Usage: node scripts/fetch-runtime-artifacts.mjs [all|typst|busytex]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
