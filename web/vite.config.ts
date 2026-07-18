import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import wasm from "vite-plugin-wasm";
import { computeAiRuntimeBuildId } from "./aiRuntimeBuildConfig";
import { loadBrowserBuildConfiguration } from "./browserBuildConfiguration";
import { loadDistributionBuildConfig } from "./distributionBuildConfig";
import { PROTOCOL_EPOCH } from "./src/lib/protocolCompatibility";

const distribution = loadDistributionBuildConfig();
const webTarget = process.env.TOSS_WEB_TARGET?.trim() || "core";
if (webTarget !== "core" && webTarget !== "browser") {
  throw new Error(`Invalid TOSS_WEB_TARGET: ${webTarget}`);
}
const browserBuild =
  webTarget === "browser" ? loadBrowserBuildConfiguration() : null;
const base = process.env.TOSS_BASE_URL?.trim() || "/";
const aiRuntimeIncluded = distribution.frontendFeatures.includes("ai_assistant");
const latexIncluded = webTarget === "core" && distribution.latexEnabled;
const aiRuntimeBuildId = computeAiRuntimeBuildId();
let distributionOutputDir = path.resolve(__dirname, "dist");

const distributionAssetsPlugin = {
  name: "toss-distribution-assets",
  apply: "build" as const,
  configResolved(config: { root: string; build: { outDir: string } }) {
    distributionOutputDir = path.resolve(config.root, config.build.outDir);
  },
  closeBundle() {
    if (!latexIncluded) {
      fs.rmSync(path.resolve(distributionOutputDir, "busytex"), { recursive: true, force: true });
    }
    if (!aiRuntimeIncluded) {
      fs.rmSync(path.resolve(distributionOutputDir, "_ai-runtime"), { recursive: true, force: true });
    }
    if (browserBuild) {
      fs.rmSync(path.resolve(distributionOutputDir, "sw.js"), { force: true });
      fs.mkdirSync(path.resolve(distributionOutputDir, "browser-assets", "typst"), {
        recursive: true,
      });
      fs.cpSync(
        browserBuild.assets.typstBuiltinPath,
        path.resolve(distributionOutputDir, "browser-assets", "typst"),
        { recursive: true },
      );
      fs.mkdirSync(path.resolve(distributionOutputDir, "browser-assets"), {
        recursive: true,
      });
      fs.copyFileSync(
        browserBuild.assets.faviconPath,
        path.resolve(
          distributionOutputDir,
          "browser-assets",
          browserBuild.assets.faviconName,
        ),
      );
      if (browserBuild.assets.touchIconPath && browserBuild.assets.touchIconName) {
        fs.copyFileSync(
          browserBuild.assets.touchIconPath,
          path.resolve(
            distributionOutputDir,
            "browser-assets",
            browserBuild.assets.touchIconName,
          ),
        );
      }
    }
    fs.writeFileSync(
      path.resolve(distributionOutputDir, "toss-build-manifest.json"),
      `${JSON.stringify(
        {
          schema: 2,
          protocol_epoch: PROTOCOL_EPOCH,
          project_types:
            browserBuild?.configuration.enabledProjectTypes ??
            distribution.projectTypes,
          frontend_features: distribution.frontendFeatures,
          ai_runtime: aiRuntimeIncluded
            ? {
                build_id: aiRuntimeBuildId,
                entry_path: "_ai-runtime/bootstrap.html",
                connection_policy: distribution.aiConnectionPolicy
              }
            : null
        },
        null,
        2
      )}\n`
    );
  }
};

const browserHtmlPlugin = {
  name: "toss-browser-html",
  transformIndexHtml(html: string) {
    if (!browserBuild) return html;
    const assetBase = base.endsWith("/") ? base : `${base}/`;
    const replace = (marker: string, value: string) => {
      if (html.split(marker).length !== 2) {
        throw new Error(`Browser HTML marker must occur exactly once: ${marker}`);
      }
      html = html.replace(marker, value);
    };
    const escapeHtml = (value: string) => value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    replace(
      'href="/v1/product-assets/favicon"',
      `href="${assetBase}browser-assets/${browserBuild.assets.faviconName}"`,
    );
    replace(
      "<title>Typst Collaboration</title>",
      `<title>${escapeHtml(browserBuild.html.title)}</title>`,
    );
    replace(
      '<meta name="description" content="A self-hostable collaborative workspace for Typst documents and presentations." />',
      `<meta name="description" content="${escapeHtml(browserBuild.html.description)}" />`,
    );
    replace(
      '<meta name="theme-color" content="#2563eb" />',
      `<meta name="theme-color" content="${browserBuild.html.accentColor}" />`,
    );
    replace(
      '<meta name="robots" content="index,follow" />',
      browserBuild.html.indexing
        ? '<meta name="robots" content="index,follow" />'
        : '<meta name="robots" content="noindex,nofollow" />',
    );
    replace(
      ":root { --app-boot-accent: #2563eb; --app-boot-contrast: #ffffff; }",
      `:root { --app-boot-accent: ${browserBuild.html.accentColor}; --app-boot-contrast: ${browserBuild.html.accentTextColor}; }`,
    );
    replace(
      "<!-- TOSS_TOUCH_ICON -->",
      browserBuild.assets.touchIconName
        ? `<link rel="apple-touch-icon" href="${assetBase}browser-assets/${browserBuild.assets.touchIconName}" />`
        : "",
    );
    return html;
  },
};

export default defineConfig({
  base,
  plugins: [react(), wasm(), browserHtmlPlugin, distributionAssetsPlugin],
  define: {
    __TOSS_BUILD_PROJECT_TYPES__: JSON.stringify(distribution.projectTypes),
    __TOSS_BUILD_FRONTEND_FEATURES__: JSON.stringify(distribution.frontendFeatures),
    __TOSS_BUILD_AI_CONNECTION_POLICY__: JSON.stringify(distribution.aiConnectionPolicy),
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify(aiRuntimeBuildId),
    __TOSS_BROWSER_BUILD_CONFIGURATION__: JSON.stringify(
      browserBuild?.configuration ?? null,
    ),
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
      ...(webTarget === "browser"
        ? [
            {
              find: /^@\/targetEntry$/,
              replacement: path.resolve(__dirname, "src/browserEntry.tsx"),
            },
          ]
        : []),
      ...(latexIncluded
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
