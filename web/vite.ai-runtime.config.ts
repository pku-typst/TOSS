import path from "node:path";
import { defineConfig } from "vite";
import { computeAiRuntimeBuildId } from "./aiRuntimeBuildConfig";
import { decorateAiRuntimeEntry } from "./aiRuntimeHtml";
import { loadDistributionBuildConfig } from "./distributionBuildConfig";

const buildId = computeAiRuntimeBuildId();
const distribution = loadDistributionBuildConfig();
if (!distribution.aiConnectionPolicy) {
  throw new Error("Cannot build the AI Runtime for a distribution without ai_assistant");
}

export default defineConfig({
  root: path.resolve(__dirname, "ai-runtime"),
  base: "/_ai-runtime/",
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
      name: "toss-ai-runtime-entry-contract",
      transformIndexHtml: {
        order: "post",
        handler: decorateAiRuntimeEntry
      }
    },
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
    modulePreload: false,
    rolldownOptions: {
      input: path.resolve(__dirname, "ai-runtime/bootstrap.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
