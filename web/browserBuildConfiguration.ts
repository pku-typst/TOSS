import fs from "node:fs";
import path from "node:path";
import { resolveDistributionConfigPath } from "./distributionBuildConfig";

type LocalizedText = { en: string; "zh-CN": string };
type ProjectType = "typst" | "latex";

type AiConnectionPolicyFile =
  | { kind: "user_defined" }
  | {
      kind: "managed_catalog";
      provider: {
        id: string;
        label: LocalizedText;
        credential_label: LocalizedText;
        protocol: string;
        base_url: string;
        catalog: string;
      };
      default_model_profile: string;
      model_profiles: Array<{
        id: string;
        model: string;
        label: LocalizedText;
        context_window: number;
        max_output_tokens: number;
        reasoning: boolean;
        request_overrides?: Record<string, unknown>;
      }>;
      custom_profiles?: {
        enabled: boolean;
        require_catalog_match: boolean;
        defaults: {
          context_window: number;
          max_output_tokens: number;
          reasoning: boolean;
          request_overrides?: Record<string, unknown>;
        };
        limits: {
          min_context_window: number;
          max_context_window: number;
          min_output_tokens: number;
          max_output_tokens: number;
        };
        max_saved_profiles: number;
      };
    };

type DistributionFile = {
  id: string;
  product: {
    name: string;
    description: LocalizedText;
    brand_mark: string;
    accent_color: string;
    accent_text_color: string;
    favicon: string;
    touch_icon?: string;
    indexing: boolean;
  };
  project_types: Record<ProjectType, { starter_template: string } | null>;
  frontend_features: {
    included: string[];
    default_enabled: string[];
  };
  ai_assistant?: { connection_policy: AiConnectionPolicyFile };
  typst: { builtin_dir: string };
  template_gallery: {
    builtins: Array<{
      id: string;
      name: LocalizedText;
      description: LocalizedText;
      category: string;
      tags: string[];
      project_type: ProjectType;
      entry_file: string;
      source_dir: string;
      thumbnail?: string;
      featured: boolean;
      accent_color?: string;
    }>;
  };
  experience: {
    landing: {
      headline: LocalizedText;
      summary: LocalizedText;
      highlights: Array<{ title: LocalizedText; description: LocalizedText }>;
    };
    resources: Array<{
      id: string;
      kind: string;
      label: LocalizedText;
      description: LocalizedText;
      url: string;
      visibility: string;
    }>;
    help: {
      topics: Array<{
        id: string;
        title: LocalizedText;
        summary: LocalizedText;
        sources: LocalizedText;
        visibility: string;
        availability?: {
          project_types?: ProjectType[];
          frontend_features?: string[];
          processing_operations?: string[];
        };
      }>;
    };
  };
};

const textExtensions = new Set([
  ".bib",
  ".csv",
  ".json",
  ".md",
  ".tex",
  ".toml",
  ".typ",
  ".txt",
  ".yaml",
  ".yml",
]);

function resolveDistributionFile(baseDir: string, relativePath: string) {
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Distribution path escapes its root: ${relativePath}`);
  }
  const realBase = fs.realpathSync(baseDir);
  const realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(realBase, realResolved);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Distribution path resolves outside its root: ${relativePath}`);
  }
  return realResolved;
}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function readTemplateFiles(root: string) {
  const files: Array<
    | { path: string; content: string }
    | { path: string; contentBase64: string; contentType: string }
  > = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push({ path: relative, content: fs.readFileSync(absolute, "utf8") });
      } else {
        files.push({
          path: relative,
          contentBase64: fs.readFileSync(absolute).toString("base64"),
          contentType: contentType(absolute),
        });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function requirementsMet(
  values: readonly string[] | undefined,
  available: ReadonlySet<string>,
) {
  return (values ?? []).every((value) => available.has(value));
}

const defaultCustomProfiles = {
  enabled: false,
  require_catalog_match: true,
  defaults: {
    context_window: 65_536,
    max_output_tokens: 8_192,
    reasoning: false,
    request_overrides: {},
  },
  limits: {
    min_context_window: 8_192,
    max_context_window: 4_194_304,
    min_output_tokens: 256,
    max_output_tokens: 1_048_576,
  },
  max_saved_profiles: 20,
};

function aiAssistantClientConfig(policy: AiConnectionPolicyFile) {
  if (policy.kind === "user_defined") return policy;
  const custom = policy.custom_profiles ?? defaultCustomProfiles;
  return {
    kind: policy.kind,
    provider: {
      id: policy.provider.id,
      label: policy.provider.label,
    },
    default_model_profile: policy.default_model_profile,
    model_profiles: policy.model_profiles.map(({ id, model, label }) => ({
      id,
      model,
      label,
    })),
    custom_profiles: {
      enabled: custom.enabled,
      require_catalog_match: custom.require_catalog_match,
      defaults: {
        context_window: custom.defaults.context_window,
        max_output_tokens: custom.defaults.max_output_tokens,
        reasoning: custom.defaults.reasoning,
        request_overrides: custom.defaults.request_overrides ?? {},
      },
      limits: custom.limits,
      max_saved_profiles: custom.max_saved_profiles,
    },
  };
}

export function loadBrowserBuildConfiguration() {
  const configPath = resolveDistributionConfigPath();
  const baseDir = path.dirname(configPath);
  const distribution = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  ) as DistributionFile;
  const product = {
    name: distribution.product.name,
    description: distribution.product.description,
    brand_mark: distribution.product.brand_mark,
    accent_color: distribution.product.accent_color,
    accent_text_color: distribution.product.accent_text_color,
  };

  // The standalone target deliberately starts with the self-contained Typst
  // runtime. LaTeX requires an independently configured, CORS-capable TeX Live
  // source and is therefore not inferred from the Core distribution contract.
  const enabledProjectTypes = new Set<ProjectType>(["typst"]);
  const enabledFrontendFeatures = new Set(
    distribution.frontend_features.default_enabled,
  );
  const typstStarterPath = resolveDistributionFile(
    baseDir,
    distribution.project_types.typst!.starter_template,
  );
  const projectSeeds = {
    typst: {
      projectType: "typst" as const,
      latexEngine: null,
      entryFilePath: path.basename(typstStarterPath),
      files: [
        {
          path: path.basename(typstStarterPath),
          content: fs.readFileSync(typstStarterPath, "utf8"),
        },
      ],
    },
    latex: null,
  };

  const templates = distribution.template_gallery.builtins
    .filter((template) => enabledProjectTypes.has(template.project_type))
    .map((template) => {
      const sourceRoot = resolveDistributionFile(baseDir, template.source_dir);
      const thumbnailPath = template.thumbnail
        ? resolveDistributionFile(baseDir, template.thumbnail)
        : null;
      return {
        item: {
          id: template.id,
          source: "builtin" as const,
          project_id: null,
          name: template.name,
          description: template.description,
          category: template.category,
          tags: template.tags,
          project_type: template.project_type,
          owner_display_name: null,
          featured: template.featured,
          can_edit: false,
          can_read: true,
          has_thumbnail: thumbnailPath !== null,
          updated_at: null,
          accent_color: template.accent_color ?? product.accent_color,
        },
        entryFilePath: template.entry_file,
        latexEngine: null,
        files: readTemplateFiles(sourceRoot),
        thumbnail: thumbnailPath
          ? {
              contentBase64: fs.readFileSync(thumbnailPath).toString("base64"),
              contentType: contentType(thumbnailPath),
            }
          : undefined,
      };
    });

  const helpTopics = distribution.experience.help.topics
    .filter((topic) => topic.visibility === "public")
    .filter((topic) =>
      requirementsMet(topic.availability?.project_types, enabledProjectTypes) &&
      requirementsMet(
        topic.availability?.frontend_features,
        enabledFrontendFeatures,
      ) &&
      (topic.availability?.processing_operations?.length ?? 0) === 0,
    )
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      content: {
        en: fs.readFileSync(resolveDistributionFile(baseDir, topic.sources.en), "utf8"),
        "zh-CN": fs.readFileSync(
          resolveDistributionFile(baseDir, topic.sources["zh-CN"]),
          "utf8",
        ),
      },
    }));

  return {
    configuration: {
      distributionId: distribution.id,
      product,
      landing: distribution.experience.landing,
      resources: distribution.experience.resources
        .filter((resource) => resource.visibility === "public")
        .map(({ visibility: _visibility, ...resource }) => resource),
      help: {
        topics: helpTopics,
        resources: distribution.experience.resources
          .filter((resource) => resource.visibility === "public")
          .map(({ visibility: _visibility, ...resource }) => resource),
      },
      enabledProjectTypes: [...enabledProjectTypes],
      enabledFrontendFeatures: [...enabledFrontendFeatures],
      aiAssistant:
        enabledFrontendFeatures.has("ai_assistant")
          ? aiAssistantClientConfig(
              distribution.ai_assistant!.connection_policy,
            )
          : null,
      projectSeeds,
      templates,
    },
    assets: {
      faviconPath: resolveDistributionFile(baseDir, distribution.product.favicon),
      faviconName: `favicon${path.extname(distribution.product.favicon).toLowerCase()}`,
      touchIconPath: distribution.product.touch_icon
        ? resolveDistributionFile(baseDir, distribution.product.touch_icon)
        : null,
      touchIconName: distribution.product.touch_icon
        ? `touch-icon${path.extname(distribution.product.touch_icon).toLowerCase()}`
        : null,
      typstBuiltinPath: resolveDistributionFile(
        baseDir,
        distribution.typst.builtin_dir,
      ),
    },
    html: {
      title: product.name,
      description: product.description.en,
      accentColor: product.accent_color,
      accentTextColor: product.accent_text_color,
      indexing: distribution.product.indexing,
    },
  };
}
