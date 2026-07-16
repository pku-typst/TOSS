import path from "node:path";
import { defineConfig } from "vitest/config";
import { computeAiRuntimeBuildId } from "./aiRuntimeBuildConfig";
import { loadDistributionBuildConfig } from "./distributionBuildConfig";

const distribution = loadDistributionBuildConfig();
const aiRuntimeBuildId = computeAiRuntimeBuildId();

export default defineConfig({
  define: {
    __TOSS_BUILD_PROJECT_TYPES__: JSON.stringify(distribution.projectTypes),
    __TOSS_BUILD_FRONTEND_FEATURES__: JSON.stringify(distribution.frontendFeatures),
    __TOSS_BUILD_AI_CONNECTION_POLICY__: JSON.stringify(distribution.aiConnectionPolicy),
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify(aiRuntimeBuildId)
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
  test: {
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"]
  }
});
