#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const runtimeConfigPath = path.join(webRoot, "typst-runtime.config.json");
const compilerRoot = path.join(repoRoot, "third-party", "typst.ts");

function fail(message) {
  throw new Error(message);
}

async function main() {
  const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigPath, "utf8"));
  const expectedRevision = runtimeConfig.compiler?.source_revision;
  const expectedLanguageVersion = runtimeConfig.typst_language_version;
  if (
    runtimeConfig.schema !== 1 ||
    !/^[a-f0-9]{40}$/i.test(expectedRevision ?? "") ||
    typeof expectedLanguageVersion !== "string" ||
    !expectedLanguageVersion
  ) {
    fail(`Invalid Typst runtime source metadata: ${runtimeConfigPath}`);
  }

  const cargo = await fs.readFile(path.join(compilerRoot, "Cargo.toml"), "utf8");
  const sourceLanguageVersion = /^typst\s*=\s*"([^"]+)"\s*$/m.exec(cargo)?.[1];
  if (sourceLanguageVersion !== expectedLanguageVersion) {
    fail(
      `Typst language version mismatch: runtime=${expectedLanguageVersion}, ` +
      `source=${sourceLanguageVersion ?? "missing"}`
    );
  }

  const { stdout } = await execFileAsync("git", ["-C", compilerRoot, "rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  const sourceRevision = stdout.trim();
  if (sourceRevision !== expectedRevision) {
    fail(`Typst compiler revision mismatch: runtime=${expectedRevision}, source=${sourceRevision}`);
  }

  process.stdout.write(
    `[typst-source] verified Typst ${expectedLanguageVersion} compiler ${sourceRevision.slice(0, 7)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
