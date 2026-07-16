import { BUILD_LATEX_ENABLED } from "@/lib/buildCapabilities";
import type { ProjectType } from "@/lib/api/types";

export type { ProjectType };

const BUILD_PROJECT_TYPES: readonly ProjectType[] = BUILD_LATEX_ENABLED
  ? ["typst", "latex"]
  : ["typst"];

type ProjectTypeConfig = {
  enabled_project_types?: ProjectType[];
};

export function buildProjectTypes(): readonly ProjectType[] {
  return BUILD_PROJECT_TYPES;
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
