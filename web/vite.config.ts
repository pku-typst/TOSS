import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import wasm from "vite-plugin-wasm";

type DistributionBuildConfig = {
  schema?: number;
  id?: string;
  capabilities?: {
    project_types?: string[];
    processing_operations?: string[];
  };
};

function loadDistributionBuildConfig() {
  const configuredPath = process.env.TOSS_CONFIG?.trim();
  const configPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(__dirname, "../distributions/community/toss.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as DistributionBuildConfig;
  if (
    config.schema !== 5 ||
    typeof config.id !== "string" ||
    !Array.isArray(config.capabilities?.project_types) ||
    !config.capabilities.project_types.includes("typst") ||
    config.capabilities.project_types.some(
      (projectType) => projectType !== "typst" && projectType !== "latex"
    ) ||
    new Set(config.capabilities.project_types).size !== config.capabilities.project_types.length ||
    !Array.isArray(config.capabilities.processing_operations) ||
    config.capabilities.processing_operations.some(
      (operation) =>
        operation !== "latex.compile.pdf/v1" &&
        operation !== "typst.export.pptx/v1" &&
        operation !== "pptx.import.typst/v1"
    ) ||
    new Set(config.capabilities.processing_operations).size !==
      config.capabilities.processing_operations.length
  ) {
    throw new Error(`Invalid distribution build config: ${configPath}`);
  }
  return {
    latexEnabled: config.capabilities.project_types.includes("latex")
  };
}

const distribution = loadDistributionBuildConfig();

const distributionAssetsPlugin = {
  name: "toss-distribution-assets",
  apply: "build" as const,
  closeBundle() {
    if (!distribution.latexEnabled) {
      fs.rmSync(path.resolve(__dirname, "dist/busytex"), { recursive: true, force: true });
    }
  }
};

export default defineConfig({
  plugins: [react(), wasm(), distributionAssetsPlugin],
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
              find: /^@\/lib\/buildCapabilities$/,
              replacement: path.resolve(
                __dirname,
                "src/lib/buildCapabilities.disabled.ts"
              )
            },
            {
              find: /^@\/lib\/latex$/,
              replacement: path.resolve(__dirname, "src/lib/latex.disabled.ts")
            },
            {
              find: /^codemirror-lang-latex$/,
              replacement: path.resolve(__dirname, "src/lib/latexLanguage.disabled.ts")
            }
          ]),
      {
        find: "@",
        replacement: path.resolve(__dirname, "src")
      }
    ]
  }
});
