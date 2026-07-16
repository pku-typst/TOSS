import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FIXED_AI_RUNTIME_BUILD_INPUTS = [
  "ai-runtime/bootstrap.html",
  "aiRuntimeHtml.ts",
  "package-lock.json",
  "vite.ai-runtime.config.ts",
  "src/features/ai/protocol.ts",
  "src/features/ai/runtimePolicy.ts",
  "src/features/ai/toolContract.ts"
] as const;

function runtimeSourceInputs(directory: string): string[] {
  return fs.readdirSync(path.resolve(__dirname, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) return runtimeSourceInputs(relativePath);
      return entry.isFile() && !entry.name.endsWith(".test.ts") ? [relativePath] : [];
    });
}

function aiRuntimeBuildInputs() {
  return [
    ...FIXED_AI_RUNTIME_BUILD_INPUTS,
    ...runtimeSourceInputs("src/ai-runtime")
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
