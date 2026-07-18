#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOMAIN_NAMES = [
  "backend",
  "container",
  "workers",
  "web",
  "web_static",
  "integration",
];

const FULL_SELECTION = Object.freeze(
  Object.fromEntries(DOMAIN_NAMES.map((domain) => [domain, true])),
);

const EMPTY_SELECTION = Object.freeze(
  Object.fromEntries(DOMAIN_NAMES.map((domain) => [domain, false])),
);

const PREFLIGHT_ONLY_PATHS = new Set([
  ".gitignore",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "scripts/check-docs.mjs",
  "scripts/ci/preflight.sh",
  "scripts/ci/release-image-tag.mjs",
  "scripts/ci/release-image-tag.test.mjs",
]);

const WORKER_PATHS = new Set([
  ".github/workflows/latex-worker-image.yml",
  "scripts/check-latex-worker-contract.mjs",
  "scripts/ci/latex-worker-image-smoke.sh",
  "scripts/ci/workers.sh",
  "scripts/processing-latex-benchmark.mjs",
  "scripts/processing-latex-worker-smoke.mjs",
]);

const APP_PATHS = new Set([
  ".github/workflows/pages.yml",
  ".gitmodules",
  "scripts/backup-minio.sh",
  "scripts/backup-postgres.sh",
  "scripts/bootstrap-admin.sh",
  "scripts/check-migration-baseline.mjs",
  "scripts/e2e-git-policy.sh",
  "scripts/fetch-runtime-artifacts.mjs",
  "scripts/processing-protocol-smoke.mjs",
  "scripts/smoke-test.sh",
  "scripts/ci/backend.sh",
  "scripts/ci/core-image-smoke.sh",
  "scripts/ci/integration.sh",
  "scripts/ci/web-static.sh",
  "scripts/ci/web.sh",
]);

function startsWithDirectory(path, directory) {
  return path.startsWith(`${directory}/`);
}

function classifyPath(path) {
  if (
    path.endsWith(".md") ||
    startsWithDirectory(path, "docs") ||
    startsWithDirectory(path, "LICENSES") ||
    startsWithDirectory(path, ".github/ISSUE_TEMPLATE") ||
    path === ".github/PULL_REQUEST_TEMPLATE.md" ||
    PREFLIGHT_ONLY_PATHS.has(path)
  ) {
    return "preflight";
  }

  if (startsWithDirectory(path, "workers") || WORKER_PATHS.has(path)) {
    return "worker";
  }

  if (
    ["backend", "config", "distributions", "prebuilt", "protocol", "web"].some(
      (directory) => startsWithDirectory(path, directory),
    ) ||
    path === "third-party/typst.ts" ||
    startsWithDirectory(path, "third-party/typst.ts") ||
    APP_PATHS.has(path)
  ) {
    return "app";
  }

  return "full";
}

export function classifyChangedPaths(paths) {
  if (paths.length === 0) {
    return { classification: "full", domains: { ...FULL_SELECTION } };
  }

  const classes = new Set(paths.map(classifyPath));
  classes.delete("preflight");

  if (classes.size === 0) {
    return { classification: "preflight", domains: { ...EMPTY_SELECTION } };
  }

  if (classes.size > 1 || classes.has("full")) {
    return { classification: "full", domains: { ...FULL_SELECTION } };
  }

  if (classes.has("worker")) {
    return {
      classification: "worker",
      domains: { ...EMPTY_SELECTION, workers: true },
    };
  }

  return {
    classification: "app",
    domains: {
      ...FULL_SELECTION,
      workers: false,
    },
  };
}

function parseChangedPaths(input) {
  if (input.includes("\0")) {
    return input.split("\0").filter(Boolean);
  }

  return input.split(/\r?\n/u).filter(Boolean);
}

function formatSelection(selection) {
  return [
    `classification=${selection.classification}`,
    ...DOMAIN_NAMES.map(
      (domain) => `${domain}=${selection.domains[domain] ? "true" : "false"}`,
    ),
  ].join("\n");
}

function main() {
  const selection = process.argv.includes("--all")
    ? { classification: "full", domains: { ...FULL_SELECTION } }
    : classifyChangedPaths(parseChangedPaths(readFileSync(0, "utf8")));

  process.stdout.write(`${formatSelection(selection)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
