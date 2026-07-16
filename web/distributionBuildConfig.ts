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
  ai_assistant?: {
    connection_policy?: {
      kind?: string;
    };
  };
};

export type AiConnectionPolicyKind = "user_defined" | "managed_catalog";

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
  const includesAi = includedFrontendFeatures?.includes("ai_assistant") ?? false;
  const aiConnectionPolicy = config.ai_assistant?.connection_policy?.kind;
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
    new Set(defaultFrontendFeatures).size !== defaultFrontendFeatures.length ||
    (includesAi && aiConnectionPolicy !== "user_defined" && aiConnectionPolicy !== "managed_catalog") ||
    (!includesAi && config.ai_assistant !== undefined)
  ) {
    throw new Error(`Invalid distribution build config: ${configPath}`);
  }
  return {
    projectTypes,
    frontendFeatures: includedFrontendFeatures,
    aiConnectionPolicy: includesAi ? aiConnectionPolicy as AiConnectionPolicyKind : null,
    latexEnabled
  };
}
