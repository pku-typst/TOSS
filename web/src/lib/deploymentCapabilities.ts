import { BUILD_FRONTEND_FEATURES, BUILD_PROJECT_TYPES } from "@/lib/buildCapabilities";
import type { FrontendFeature, ProjectType } from "@/lib/api/types";

export type { ProjectType };

type ProjectTypeConfig = {
  enabled_project_types?: ProjectType[];
};

type FrontendFeatureConfig = {
  enabled_frontend_features?: FrontendFeature[];
};

export function buildProjectTypes(): readonly ProjectType[] {
  return BUILD_PROJECT_TYPES;
}

export function buildFrontendFeatures(): readonly FrontendFeature[] {
  return BUILD_FRONTEND_FEATURES;
}

export function deploymentProjectTypes(config: ProjectTypeConfig | null | undefined): ProjectType[] {
  const configured = config?.enabled_project_types;
  if (!configured) return [...BUILD_PROJECT_TYPES];
  const enabled = BUILD_PROJECT_TYPES.filter((projectType) => configured.includes(projectType));
  return enabled.includes("typst") ? enabled : ["typst"];
}

export function deploymentSupportsProjectType(
  config: ProjectTypeConfig | null | undefined,
  projectType: ProjectType
): boolean {
  return deploymentProjectTypes(config).includes(projectType);
}

export function deploymentFrontendFeatures(
  config: FrontendFeatureConfig | null | undefined
): FrontendFeature[] {
  const configured = config?.enabled_frontend_features;
  if (!configured) return [];
  return BUILD_FRONTEND_FEATURES.filter((feature) => configured.includes(feature));
}

export function deploymentEnablesFrontendFeature(
  config: FrontendFeatureConfig | null | undefined,
  feature: FrontendFeature
): boolean {
  return deploymentFrontendFeatures(config).includes(feature);
}
