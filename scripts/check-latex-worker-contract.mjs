#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "workers/latex/processor-contract.json");

function filesBelow(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  return fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? filesBelow(relative) : [relative];
    });
}

const implementationFiles = [
  "workers/Cargo.lock",
  "workers/Cargo.toml",
  "workers/processing-sdk/Cargo.toml",
  ...filesBelow("workers/processing-sdk/src"),
  "workers/latex/Cargo.toml",
  "workers/latex/Dockerfile",
  "workers/latex/latexmkrc",
  "workers/latex/toss-latex-worker.apparmor",
  ...filesBelow("workers/latex/src")
].sort();

const hash = crypto.createHash("sha256");
for (const relative of implementationFiles) {
  const content = fs.readFileSync(path.join(root, relative));
  hash.update(Buffer.from(`${relative}\0${content.length}\0`, "utf8"));
  hash.update(content);
}
const actual = hash.digest("hex");

if (process.argv.includes("--print")) {
  process.stdout.write(`${actual}\n`);
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const dockerfile = fs.readFileSync(path.join(root, "workers/latex/Dockerfile"), "utf8");
const runtime = manifest.runtime;
const fail = (message) => {
  process.stderr.write(`LaTeX worker contract is invalid: ${message}\n`);
  process.exit(1);
};
const sha256 = (value, field) => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
};

if (!runtime || typeof runtime !== "object") fail("runtime metadata is missing");
if (!/^texlive\/texlive@sha256:[0-9a-f]{64}$/.test(runtime.image ?? "")) {
  fail("runtime.image must pin the TeX Live image by digest");
}
if (!dockerfile.includes(`FROM ${runtime.image}\n`)) {
  fail("Dockerfile base does not match runtime.image");
}
if (runtime.tex_live_release !== "2026" || !Number.isInteger(runtime.tex_live_revision)) {
  fail("TeX Live release and revision must identify the pinned 2026 snapshot");
}

const fingerprints = [
  [runtime.tex_live_database_sha256, "runtime.tex_live_database_sha256"],
  [runtime.texmf_file_database_sha256, "runtime.texmf_file_database_sha256"],
  [runtime.fontconfig_listing_sha256, "runtime.fontconfig_listing_sha256"],
  ...((runtime.engines ?? []).map((engine, index) => [
    engine.format_sha256,
    `runtime.engines[${index}].format_sha256`
  ]))
];
for (const [value, field] of fingerprints) {
  const digest = sha256(value, field);
  if (!dockerfile.includes(digest)) fail(`${field} is not verified by the Dockerfile`);
}
if (!dockerfile.includes(`'${runtime.tex_live_revision}'`)) {
  fail("Dockerfile does not verify runtime.tex_live_revision");
}
if (!dockerfile.includes(`Version ${runtime.driver?.version}`)) {
  fail("Dockerfile does not verify the declared latexmk version");
}
for (const engine of runtime.engines ?? []) {
  if (!dockerfile.includes(engine.version ?? "")) {
    fail(`Dockerfile does not verify the declared ${engine.name ?? "engine"} version`);
  }
}
if (!dockerfile.includes(`bubblewrap ${manifest.sandbox?.bubblewrap_version}`)) {
  fail("Dockerfile does not verify the declared bubblewrap version");
}

if (manifest.implementation_sha256 !== actual) {
  process.stderr.write(
    `LaTeX worker implementation digest is stale: expected ${actual}, found ${manifest.implementation_sha256}\n`
  );
  process.exit(1);
}

process.stdout.write(`LaTeX worker implementation digest verified: ${actual}\n`);
