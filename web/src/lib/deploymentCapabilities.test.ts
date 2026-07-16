import { describe, expect, it } from "vitest";
import {
  buildFrontendFeatures,
  buildProjectTypes,
  deploymentEnablesFrontendFeature,
  deploymentFrontendFeatures,
  deploymentProjectTypes,
  deploymentSupportsProjectType
} from "@/lib/deploymentCapabilities";

describe("deployment project type capabilities", () => {
  it("always builds and exposes Typst", () => {
    expect(buildProjectTypes()).toContain("typst");
    expect(deploymentProjectTypes({ enabled_project_types: ["typst"] })).toEqual(["typst"]);
  });

  it("never exposes a project type omitted from the frontend build", () => {
    const enabled = deploymentProjectTypes({ enabled_project_types: ["typst", "latex"] });
    expect(enabled).toEqual(buildProjectTypes());
  });

  it("fails closed for LaTeX when runtime configuration disables it", () => {
    expect(
      deploymentSupportsProjectType({ enabled_project_types: ["typst"] }, "latex")
    ).toBe(false);
  });

  it("keeps frontend features independent from project types and bounded by the build", () => {
    expect(deploymentFrontendFeatures({ enabled_frontend_features: [] })).toEqual([]);
    expect(
      deploymentEnablesFrontendFeature(
        { enabled_frontend_features: ["ai_assistant"] },
        "ai_assistant"
      )
    ).toBe(buildFrontendFeatures().includes("ai_assistant"));
  });
});
