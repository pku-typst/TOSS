import fs from "node:fs";
import path from "node:path";

type DistributionBuildConfig = {
  schema?: number;
  id?: string;
  project_types?: {
    typst?: { starter_template?: string };
    latex?: { starter_template?: string } | null;
  };
  frontend_features?: {
    included?: string[];
    default_enabled?: string[];
  };
};

export function loadDistributionBuildConfig() {
  const configuredPath = process.env.TOSS_CONFIG?.trim();
  const configPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(__dirname, "../distributions/community/toss.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as DistributionBuildConfig;
  const configuredProjectTypeKeys = Object.keys(config.project_types ?? {});
  const latexConfig = config.project_types?.latex;
  const latexEnabled = latexConfig != null;
  const projectTypes = latexEnabled ? ["typst", "latex"] : ["typst"];
  const includedFrontendFeatures = config.frontend_features?.included;
  const defaultFrontendFeatures = config.frontend_features?.default_enabled;
  if (
    config.schema !== 6 ||
    typeof config.id !== "string" ||
    typeof config.project_types?.typst?.starter_template !== "string" ||
    configuredProjectTypeKeys.some(
      (projectType) => projectType !== "typst" && projectType !== "latex"
    ) ||
    (latexEnabled && typeof latexConfig.starter_template !== "string") ||
    !Array.isArray(includedFrontendFeatures) ||
    includedFrontendFeatures.some((feature) => feature !== "ai_assistant") ||
    new Set(includedFrontendFeatures).size !== includedFrontendFeatures.length ||
    !Array.isArray(defaultFrontendFeatures) ||
    defaultFrontendFeatures.some((feature) => !includedFrontendFeatures.includes(feature)) ||
    new Set(defaultFrontendFeatures).size !== defaultFrontendFeatures.length
  ) {
    throw new Error(`Invalid distribution build config: ${configPath}`);
  }
  return {
    projectTypes,
    frontendFeatures: includedFrontendFeatures,
    latexEnabled
  };
}
