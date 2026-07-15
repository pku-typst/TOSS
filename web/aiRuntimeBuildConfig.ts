import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AI_RUNTIME_BUILD_INPUTS = [
  "ai-runtime/bootstrap.html",
  "aiRuntimeHtml.ts",
  "package-lock.json",
  "vite.ai-runtime.config.ts",
  "src/features/ai/protocol.ts",
  "src/features/ai/runtimePolicy.ts",
  "src/ai-runtime/bootstrap.ts",
  "src/ai-runtime/i18n.ts",
  "src/ai-runtime/runtime.ts"
] as const;

export function computeAiRuntimeBuildId() {
  const hash = createHash("sha256");
  for (const relativePath of AI_RUNTIME_BUILD_INPUTS) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.resolve(__dirname, relativePath)));
    hash.update("\0");
  }
  return `ai-runtime-v1-${hash.digest("hex").slice(0, 20)}`;
}
