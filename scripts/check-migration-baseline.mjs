#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "backend", "migrations");
const baselineFile = "202607120001_baseline.sql";
const baselineVersion = 202607120001n;
const baselineSha256 = "fafb19bc89a581a87045eb33f37f91c38ab1bc3823029a0f64c0185de6bffac8";
const migrationPattern = /^(\d+)_([a-z0-9_]+)\.sql$/;

const files = fs
  .readdirSync(migrationDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();

if (!files.includes(baselineFile)) {
  throw new Error(`Missing canonical Community migration baseline: ${baselineFile}`);
}

for (const file of files) {
  const match = migrationPattern.exec(file);
  if (!match) {
    throw new Error(`Migration filename does not follow the SQLx version_name contract: ${file}`);
  }
  if (file !== baselineFile && BigInt(match[1]) <= baselineVersion) {
    throw new Error(`Migration ${file} must have a version newer than ${baselineFile}`);
  }
}

const baseline = fs.readFileSync(path.join(migrationDirectory, baselineFile));
const actualSha256 = createHash("sha256").update(baseline).digest("hex");
if (actualSha256 !== baselineSha256) {
  throw new Error(
    `Community migration baseline checksum changed: expected ${baselineSha256}, got ${actualSha256}`,
  );
}

console.log(
  `[migrations] canonical baseline verified (${baselineFile}, sha256=${actualSha256.slice(0, 12)})`,
);
