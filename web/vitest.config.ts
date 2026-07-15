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
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify(aiRuntimeBuildId)
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"]
  }
});
