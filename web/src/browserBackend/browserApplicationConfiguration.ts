import type { BrowserBackendConfiguration } from "@/browserBackend/BrowserBackendProvider";
import type {
  BrowserProjectSeed,
  BrowserTemplateDefinition,
} from "@/browserBackend/browserRecords";
import type {
  AuthConfig,
  AuthUser,
  Experience,
  ExperienceLanding,
  ExperienceProduct,
  ExperienceResource,
  FrontendFeature,
  HelpContent,
  ProjectType,
} from "@/lib/api/types";

export type BrowserBuildConfiguration = {
  distributionId: string;
  product: ExperienceProduct;
  landing: ExperienceLanding;
  resources: ExperienceResource[];
  help: HelpContent;
  enabledProjectTypes: ProjectType[];
  enabledFrontendFeatures: FrontendFeature[];
  aiAssistant: AuthConfig["ai_assistant"];
  projectSeeds: Record<"typst" | "latex", BrowserProjectSeed | null>;
  templates: BrowserTemplateDefinition[];
};

export const browserBuildConfiguration =
  __TOSS_BROWSER_BUILD_CONFIGURATION__;

export const browserAuthUser: AuthUser = {
  user_id: "00000000-0000-4000-8000-000000000001",
  username: "browser",
  display_name: "Browser workspace",
  email: "browser@localhost.invalid",
  session_expires_at: "9999-12-31T23:59:59Z",
};

export function browserExperience(): Experience {
  return {
    distribution_id: browserBuildConfiguration.distributionId,
    product: browserBuildConfiguration.product,
    landing: browserBuildConfiguration.landing,
    resources: browserBuildConfiguration.resources,
  };
}

export function browserAuthConfig(): AuthConfig {
  const product = browserBuildConfiguration.product;
  return {
    accent_color: product.accent_color,
    accent_text_color: product.accent_text_color,
    ai_assistant: browserBuildConfiguration.aiAssistant,
    allow_local_login: false,
    allow_local_registration: false,
    allow_oidc: false,
    announcement: "",
    anonymous_mode: "off",
    brand_mark: product.brand_mark,
    client_id: null,
    distribution_id: browserBuildConfiguration.distributionId,
    enabled_frontend_features:
      browserBuildConfiguration.enabledFrontendFeatures,
    enabled_project_types: browserBuildConfiguration.enabledProjectTypes,
    external_git_providers: [],
    groups_claim: "groups",
    identity_providers: [],
    issuer: null,
    redirect_uri: null,
    site_name: product.name,
    site_name_managed: true,
  };
}

export function browserBackendConfiguration(): BrowserBackendConfiguration {
  const applicationBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  return {
    projectSeeds: browserBuildConfiguration.projectSeeds,
    templates: browserBuildConfiguration.templates,
    compilation: {
      typst: {
        builtinBaseUrl: new URL(
          "browser-assets/typst/",
          applicationBaseUrl,
        ).toString(),
        builtinCredentials: "same-origin",
        packageSource: {
          kind: "preview",
          baseUrl: "https://packages.typst.org",
        },
        runtimeBaseUrl: new URL(
          "typst-runtime/",
          applicationBaseUrl,
        ).toString(),
        fontAssetsBaseUrl: new URL(
          "vendor/typst-assets/fonts/",
          applicationBaseUrl,
        ).toString(),
      },
      latex: null,
    },
  };
}
