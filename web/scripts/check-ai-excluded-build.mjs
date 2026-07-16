import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "toss-no-ai-build-"));
const previousConfig = process.env.TOSS_CONFIG;
const bundledModules = new Set();

function sourceModule(id) {
  const filename = id.split("?", 1)[0];
  if (!path.isAbsolute(filename)) return filename;
  return path.relative(webRoot, filename).split(path.sep).join("/");
}

try {
  process.env.TOSS_CONFIG = path.resolve(webRoot, "test-fixtures/distribution-no-ai.json");
  await build({
    configFile: path.resolve(webRoot, "vite.config.ts"),
    logLevel: "warn",
    publicDir: false,
    plugins: [{
      name: "capture-no-ai-build-modules",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const id of Object.keys(output.modules)) bundledModules.add(sourceModule(id));
        }
      }
    }],
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
  if (assets.some((name) => name.startsWith("KaTeX_"))) {
    throw new Error("AI-excluded build contains KaTeX font assets");
  }
  const forbiddenModules = [
    "src/features/ai/AssistantPanel.tsx",
    "src/pages/workspace/candidateCompilation.ts",
    "src/lib/candidateRuntime.ts",
    "src/ai-runtime/typstDocsSearch.ts"
  ];
  const includedForbiddenModule = forbiddenModules.find((module) => bundledModules.has(module));
  if (includedForbiddenModule) {
    throw new Error(`AI-excluded build contains AI-only module ${includedForbiddenModule}`);
  }
  for (const name of assets.filter((asset) => asset.endsWith(".js"))) {
    const source = await fs.readFile(path.join(outputDir, "assets", name), "utf8");
    if (source.includes("query_typst_docs")) {
      throw new Error(`AI-excluded build contains the Typst docs tool in ${name}`);
    }
  }
  try {
    await fs.access(path.join(outputDir, "_ai-runtime"));
    throw new Error("AI-excluded build contains an AI Runtime artifact");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  console.log("[ai-excluded-build] no Assistant, candidate compiler, docs tool, KaTeX, or Runtime artifact");
} finally {
  if (previousConfig === undefined) delete process.env.TOSS_CONFIG;
  else process.env.TOSS_CONFIG = previousConfig;
  await fs.rm(outputDir, { recursive: true, force: true });
}
