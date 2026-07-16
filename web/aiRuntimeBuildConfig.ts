import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FIXED_AI_RUNTIME_BUILD_INPUTS = [
  "ai-runtime/bootstrap.html",
  "aiRuntimeBuildConfig.ts",
  "aiRuntimeHtml.ts",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  "vite.ai-runtime.config.ts"
] as const;

function runtimeSourceInputs(directory: string): string[] {
  return fs.readdirSync(path.resolve(__dirname, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) return runtimeSourceInputs(relativePath);
      return entry.isFile() && !/\.test\.[^.]+$/.test(entry.name) ? [relativePath] : [];
    });
}

export function aiRuntimeBuildInputs() {
  return [
    ...FIXED_AI_RUNTIME_BUILD_INPUTS,
    // The build identity is a deployment fence, not a cache optimization. Hash
    // every production browser source so a future transitive Runtime import can
    // never escape the host/iframe version binding.
    ...runtimeSourceInputs("src")
  ].sort();
}

export function computeAiRuntimeBuildId() {
  const hash = createHash("sha256");
  for (const relativePath of aiRuntimeBuildInputs()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.resolve(__dirname, relativePath)));
    hash.update("\0");
  }
  return `ai-runtime-v1-${hash.digest("hex").slice(0, 20)}`;
}
