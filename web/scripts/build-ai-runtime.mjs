import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const configuredPath = process.env.TOSS_CONFIG?.trim();
const configPath = configuredPath
  ? path.resolve(process.cwd(), configuredPath)
  : path.resolve(webRoot, "../distributions/community/toss.json");
const distribution = JSON.parse(fs.readFileSync(configPath, "utf8"));
const included = distribution.frontend_features?.included;
if (!Array.isArray(included)) {
  throw new Error(`Invalid frontend feature configuration: ${configPath}`);
}

const outputDir = path.resolve(webRoot, "dist/_ai-runtime");
const webManifestPath = path.resolve(webRoot, "dist/toss-build-manifest.json");
fs.rmSync(outputDir, { recursive: true, force: true });

if (included.includes("ai_assistant")) {
  await build({
    configFile: path.resolve(webRoot, "vite.ai-runtime.config.ts")
  });
  const entryPath = path.join(outputDir, "bootstrap.html");
  const entry = fs.readFileSync(entryPath, "utf8");
  if (!entry.includes('data-toss-ai-nonce="__TOSS_AI_RUNTIME_NONCE__"')) {
    throw new Error(`AI Runtime entry lost its nonce marker: ${entryPath}`);
  }
  const webManifest = JSON.parse(fs.readFileSync(webManifestPath, "utf8"));
  const runtimeDescriptor = JSON.parse(
    fs.readFileSync(path.join(outputDir, "runtime-build.json"), "utf8")
  );
  if (
    webManifest.ai_runtime?.build_id !== runtimeDescriptor.build_id ||
    webManifest.ai_runtime?.entry_path !== "_ai-runtime/bootstrap.html"
  ) {
    throw new Error(
      "AI Runtime artifact does not match the main web build manifest; rebuild the complete web bundle"
    );
  }
} else {
  const webManifest = JSON.parse(fs.readFileSync(webManifestPath, "utf8"));
  if (webManifest.ai_runtime !== null) {
    throw new Error(
      "The main web build manifest describes an AI Runtime excluded by the distribution"
    );
  }
}
