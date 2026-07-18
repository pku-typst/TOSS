import path from "node:path";
import { defineConfig } from "vite";
import { computeAiRuntimeBuildId } from "./aiRuntimeBuildConfig";
import { loadDistributionBuildConfig } from "./distributionBuildConfig";

const buildId = computeAiRuntimeBuildId();
const distribution = loadDistributionBuildConfig();
const applicationBase = process.env.TOSS_BASE_URL?.trim() || "/";
const runtimeBase = `${applicationBase.endsWith("/") ? applicationBase : `${applicationBase}/`}_ai-runtime/`;
const browserTarget = process.env.TOSS_WEB_TARGET?.trim() === "browser";
if (!distribution.aiConnectionPolicy) {
  throw new Error("Cannot build the AI Runtime for a distribution without ai_assistant");
}

export default defineConfig({
  root: path.resolve(__dirname, "ai-runtime"),
  base: runtimeBase,
  publicDir: false,
  define: {
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify(buildId),
    __TOSS_BUILD_AI_CONNECTION_POLICY__: JSON.stringify(distribution.aiConnectionPolicy)
  },
  resolve: {
    alias: [
      {
        find: "@earendil-works/pi-ai/compat",
        replacement: path.resolve(__dirname, "src/ai-runtime/piAgentCompat.ts")
      },
      {
        find: "@",
        replacement: path.resolve(__dirname, "src")
      }
    ]
  },
  plugins: [
    {
      name: "toss-ai-runtime-build-descriptor",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "runtime-build.json",
          source: `${JSON.stringify({
            schema: 1,
            build_id: buildId,
            connection_policy: distribution.aiConnectionPolicy
          }, null, 2)}\n`
        });
      }
    }
  ],
  build: {
    target: "es2022",
    outDir: path.resolve(__dirname, "dist/_ai-runtime"),
    emptyOutDir: true,
    manifest: "runtime-vite-manifest.json",
    modulePreload: false,
    rolldownOptions: {
      input: path.resolve(__dirname, "src/ai-runtime/bootstrap.ts"),
      output: {
        codeSplitting: browserTarget ? false : undefined,
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
