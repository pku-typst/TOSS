#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "protocol/package.json"));
let loadYaml;
try {
  ({ load: loadYaml } = require("js-yaml"));
} catch {
  console.error("Documentation checks require `npm ci` in protocol/.");
  process.exit(1);
}
const requiredFields = [
  "title",
  "summary",
  "status",
  "type",
  "scope",
  "audience",
  "topics",
  "related",
  "code_paths",
];
const listFields = new Set(["audience", "topics", "related", "code_paths"]);
const scalarFields = new Set(["title", "summary", "status", "type", "scope"]);
const statuses = new Set(["current", "accepted", "superseded"]);
const scopes = new Set(["community"]);
const types = new Set([
  "index",
  "overview",
  "guide",
  "reference",
  "architecture",
  "decision",
]);
const errors = [];

function repositoryPath(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function collectMarkdown(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectMarkdown(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(absolutePath);
    }
  }
  return result;
}

const managedFiles = [
  path.join(root, "README.md"),
  path.join(root, "protocol/README.md"),
  path.join(root, "web/DESIGN.md"),
  ...collectMarkdown(path.join(root, "docs")),
].sort();
const managedPaths = new Set(managedFiles.map(repositoryPath));

function expectedScope(file) {
  const value = repositoryPath(file);
  if (
    value === "README.md" ||
    value === "protocol/README.md" ||
    value === "web/DESIGN.md" ||
    value.startsWith("docs/community/")
  ) {
    return "community";
  }
  return undefined;
}

function report(file, message) {
  errors.push(repositoryPath(file) + ": " + message);
}

function parseFrontmatter(file, source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    report(file, "must start with YAML frontmatter");
    return { metadata: {}, body: source };
  }

  const end = lines.indexOf("---", 1);
  if (end < 0) {
    report(file, "frontmatter is missing its closing delimiter");
    return { metadata: {}, body: "" };
  }

  let metadata = {};
  try {
    const parsed = loadYaml(lines.slice(1, end).join("\n"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      report(file, "frontmatter must be a YAML mapping");
    } else {
      metadata = parsed;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report(file, "frontmatter is invalid YAML: " + message.split("\n", 1)[0]);
  }

  for (const key of Object.keys(metadata)) {
    if (!requiredFields.includes(key)) {
      report(file, "frontmatter uses unknown field " + key);
    }
  }

  return { metadata, body: lines.slice(end + 1).join("\n") };
}

function validateRepositoryTarget(file, value, field) {
  if (
    typeof value !== "string" ||
    value === "" ||
    path.isAbsolute(value) ||
    value.split("/").includes("..") ||
    value.includes("#") ||
    value.includes("?")
  ) {
    report(file, field + " contains invalid repository-relative target " + JSON.stringify(value));
    return;
  }

  const absoluteTarget = path.resolve(root, value);
  if (!absoluteTarget.startsWith(root + path.sep) || !fs.existsSync(absoluteTarget)) {
    report(file, field + " target does not exist: " + value);
  }
}

function validateMarkdownLinks(file, source) {
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.replace(/\s+["'][^"']*["']$/, "");
    if (
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith("//")
    ) {
      continue;
    }
    if (target.startsWith("/")) {
      report(file, "local Markdown link must be relative: " + target);
      continue;
    }

    const withoutFragment = target.split(/[?#]/, 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      report(file, "Markdown link is not valid URI syntax: " + target);
      continue;
    }
    const absoluteTarget = path.resolve(path.dirname(file), decoded);
    if (!fs.existsSync(absoluteTarget)) {
      report(file, "Markdown link target does not exist: " + target);
      continue;
    }
    if (!absoluteTarget.startsWith(root + path.sep)) {
      report(file, "local Markdown link escapes the repository: " + target);
      continue;
    }
  }
}

const pagesByPath = new Map(
  managedFiles.map((file) => {
    const source = fs.readFileSync(file, "utf8");
    return [repositoryPath(file), { file, source, ...parseFrontmatter(file, source) }];
  }),
);
const titles = new Map();
for (const { file, source, metadata, body } of pagesByPath.values()) {

  for (const field of requiredFields) {
    if (!Object.hasOwn(metadata, field)) {
      report(file, "frontmatter is missing required field " + field);
    }
  }
  for (const field of scalarFields) {
    if (typeof metadata[field] !== "string" || metadata[field].trim() === "") {
      report(file, field + " must be a non-empty scalar");
    }
  }
  for (const field of listFields) {
    if (!Array.isArray(metadata[field]) || metadata[field].length === 0) {
      report(file, field + " must be a non-empty list");
    } else if (new Set(metadata[field]).size !== metadata[field].length) {
      report(file, field + " must not contain duplicate values");
    }
  }

  if (typeof metadata.status === "string" && !statuses.has(metadata.status)) {
    report(file, "status must be current, accepted, or superseded");
  }
  if (typeof metadata.type === "string" && !types.has(metadata.type)) {
    report(file, "type is not a supported page role: " + metadata.type);
  }
  if (typeof metadata.scope === "string" && !scopes.has(metadata.scope)) {
    report(file, "scope must be community");
  }
  const requiredScope = expectedScope(file);
  if (!requiredScope) {
    report(file, "managed page is outside the Community documentation boundary");
  } else if (metadata.scope !== requiredScope) {
    report(file, "scope must be " + requiredScope + " at this repository path");
  }
  if (
    metadata.type === "decision" &&
    metadata.status !== "accepted" &&
    metadata.status !== "superseded"
  ) {
    report(file, "a decision must be accepted or superseded");
  }

  for (const field of ["audience", "topics"]) {
    if (Array.isArray(metadata[field])) {
      for (const value of metadata[field]) {
        if (
          typeof value !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ) {
          report(
            file,
            field + " values must be lowercase stable identifiers: " + JSON.stringify(value),
          );
        }
      }
    }
  }
  for (const value of metadata.related ?? []) {
    validateRepositoryTarget(file, value, "related");
    if (typeof value === "string" && !value.endsWith(".md")) {
      report(file, "related targets must be Markdown pages: " + value);
    } else if (typeof value === "string" && !managedPaths.has(value)) {
      report(file, "related target is outside the managed Wiki: " + value);
    } else if (typeof value === "string" && value === repositoryPath(file)) {
      report(file, "related must not point to the current page");
    }
  }
  for (const value of metadata.code_paths ?? []) {
    validateRepositoryTarget(file, value, "code_paths");
  }

  if (typeof metadata.title === "string") {
    const previous = titles.get(metadata.title);
    if (previous) {
      report(file, "title duplicates " + repositoryPath(previous));
    } else {
      titles.set(metadata.title, file);
    }
  }
  const pageTitle = /^# (.+)$/m.exec(body)?.[1];
  if (!pageTitle) {
    report(file, "body must contain a level-one title");
  } else if (pageTitle !== metadata.title) {
    report(file, "level-one title must equal frontmatter title");
  }
  const sections = [...body.matchAll(/^## .+$/gm)].map((match) => match[0]);
  if (sections.at(-1) !== "## Related") {
    report(file, "Related must be the final level-two section");
  }
  if (/[\u3400-\u9fff]/u.test(source)) {
    report(file, "engineering documentation must be English-only");
  }
  if (!source.endsWith("\n")) {
    report(file, "file must end with a newline");
  }
  validateMarkdownLinks(file, body);
}

if (fs.existsSync(path.join(root, "README.zh-CN.md"))) {
  errors.push("README.zh-CN.md: translated engineering-document mirrors are not supported");
}

const apiDocument = fs.readFileSync(
  path.join(root, "docs/community/reference/api.md"),
  "utf8",
);
const openapi = JSON.parse(
  fs.readFileSync(path.join(root, "protocol/openapi.json"), "utf8"),
);
const documentedOperations = new Map();
const operationPattern = /^- \x60([A-Z|]+) (\/[^\x60?]+)(?:\?[^\x60]*)?\x60/gm;
for (const match of apiDocument.matchAll(operationPattern)) {
  documentedOperations.set(
    match[2],
    new Set(match[1].split("|").map((method) => method.toLowerCase())),
  );
}
for (const [apiPath, pathItem] of Object.entries(openapi.paths)) {
  const documentedMethods = documentedOperations.get(apiPath);
  if (!documentedMethods) {
    errors.push("docs/community/reference/api.md: missing OpenAPI path " + apiPath);
    continue;
  }
  const contractMethods = new Set(
    Object.keys(pathItem).filter((method) => method !== "parameters"),
  );
  if (
    [...contractMethods].sort().join(",") !==
    [...documentedMethods].sort().join(",")
  ) {
    errors.push(
      "docs/community/reference/api.md: methods for " +
        apiPath +
        " are " +
        [...documentedMethods].sort().join("|").toUpperCase() +
        "; OpenAPI requires " +
        [...contractMethods].sort().join("|").toUpperCase(),
    );
  }
}

if (errors.length > 0) {
  console.error(
    "Documentation checks failed:\n\n" +
      errors.map((error) => "- " + error).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    "Documentation checks passed (" + managedFiles.length + " pages).",
  );
}
