import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "toss-no-ai-build-"));
const previousConfig = process.env.TOSS_CONFIG;

try {
  process.env.TOSS_CONFIG = path.resolve(webRoot, "test-fixtures/distribution-no-ai.json");
  await build({
    configFile: path.resolve(webRoot, "vite.config.ts"),
    logLevel: "warn",
    publicDir: false,
    build: {
      outDir: outputDir,
      emptyOutDir: true
    }
  });

  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, "toss-build-manifest.json"), "utf8")
  );
  if (
    manifest.schema !== 2 ||
    manifest.frontend_features?.length !== 0 ||
    manifest.ai_runtime !== null
  ) {
    throw new Error(`AI-excluded build manifest is invalid: ${JSON.stringify(manifest)}`);
  }

  const assets = await fs.readdir(path.join(outputDir, "assets"));
  if (assets.some((name) => name.startsWith("AssistantPanel-"))) {
    throw new Error("AI-excluded build contains an AssistantPanel chunk");
  }
  try {
    await fs.access(path.join(outputDir, "_ai-runtime"));
    throw new Error("AI-excluded build contains an AI Runtime artifact");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  console.log("[ai-excluded-build] no Assistant chunk or Runtime artifact");
} finally {
  if (previousConfig === undefined) delete process.env.TOSS_CONFIG;
  else process.env.TOSS_CONFIG = previousConfig;
  await fs.rm(outputDir, { recursive: true, force: true });
}
