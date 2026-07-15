import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import wasm from "vite-plugin-wasm";
import { computeAiRuntimeBuildId } from "./aiRuntimeBuildConfig";
import { loadDistributionBuildConfig } from "./distributionBuildConfig";

const distribution = loadDistributionBuildConfig();
const aiRuntimeIncluded = distribution.frontendFeatures.includes("ai_assistant");
const aiRuntimeBuildId = computeAiRuntimeBuildId();
let distributionOutputDir = path.resolve(__dirname, "dist");

const distributionAssetsPlugin = {
  name: "toss-distribution-assets",
  apply: "build" as const,
  configResolved(config: { root: string; build: { outDir: string } }) {
    distributionOutputDir = path.resolve(config.root, config.build.outDir);
  },
  closeBundle() {
    if (!distribution.latexEnabled) {
      fs.rmSync(path.resolve(distributionOutputDir, "busytex"), { recursive: true, force: true });
    }
    if (!aiRuntimeIncluded) {
      fs.rmSync(path.resolve(distributionOutputDir, "_ai-runtime"), { recursive: true, force: true });
    }
    fs.writeFileSync(
      path.resolve(distributionOutputDir, "toss-build-manifest.json"),
      `${JSON.stringify(
        {
          schema: 2,
          project_types: distribution.projectTypes,
          frontend_features: distribution.frontendFeatures,
          ai_runtime: aiRuntimeIncluded
            ? {
                build_id: aiRuntimeBuildId,
                entry_path: "_ai-runtime/bootstrap.html"
              }
            : null
        },
        null,
        2
      )}\n`
    );
  }
};

export default defineConfig({
  plugins: [react(), wasm(), distributionAssetsPlugin],
  define: {
    __TOSS_BUILD_PROJECT_TYPES__: JSON.stringify(distribution.projectTypes),
    __TOSS_BUILD_FRONTEND_FEATURES__: JSON.stringify(distribution.frontendFeatures),
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify(aiRuntimeBuildId)
  },
  worker: {
    format: "es"
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: true,
          groups: [
            {
              name: "preload-helper",
              test: (id) => id.includes("vite/preload-helper"),
              priority: 10
            },
            {
              name: "vendor-react",
              test: (id) =>
                id.includes("/node_modules/react") || id.includes("/node_modules/scheduler")
            },
            {
              name: "vendor-router",
              test: (id) => id.includes("/node_modules/react-router")
            },
            {
              name: "vendor-editor",
              test: (id) =>
                id.includes("/node_modules/@codemirror/") ||
                id.includes("/node_modules/codemirror") ||
                id.includes("/node_modules/@lezer/")
            },
            {
              name: "vendor-collab-typst",
              test: (id) =>
                id.includes("/node_modules/yjs") ||
                id.includes("/node_modules/@myriaddreamin/") ||
                id.includes("/node_modules/texlyre-busytex/")
            }
          ]
        }
      }
    }
  },
  resolve: {
    alias: [
      ...(distribution.latexEnabled
        ? []
        : [
            {
              find: /^@\/lib\/latex$/,
              replacement: path.resolve(__dirname, "src/lib/latex.disabled.ts")
            },
            {
              find: /^codemirror-lang-latex$/,
              replacement: path.resolve(__dirname, "src/lib/latexLanguage.disabled.ts")
            }
          ]),
      ...(!aiRuntimeIncluded
        ? [
            {
              find: /^@\/features\/ai$/,
              replacement: path.resolve(__dirname, "src/features/ai.disabled.tsx")
            }
          ]
        : []),
      {
        find: "@",
        replacement: path.resolve(__dirname, "src")
      }
    ]
  }
});
