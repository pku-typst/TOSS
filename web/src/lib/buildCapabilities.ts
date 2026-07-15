import type { FrontendFeature, ProjectType } from "@/lib/api/types";

declare const __TOSS_BUILD_PROJECT_TYPES__: readonly ProjectType[];
declare const __TOSS_BUILD_FRONTEND_FEATURES__: readonly FrontendFeature[];

export const BUILD_PROJECT_TYPES = __TOSS_BUILD_PROJECT_TYPES__;
export const BUILD_FRONTEND_FEATURES = __TOSS_BUILD_FRONTEND_FEATURES__;
export const BUILD_LATEX_ENABLED = BUILD_PROJECT_TYPES.includes("latex");
