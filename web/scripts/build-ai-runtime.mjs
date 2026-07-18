import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { renderAiRuntimeEntry } from "../aiRuntimeHtml.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const configuredPath = process.env.TOSS_CONFIG?.trim();
const configPath = configuredPath
  ? path.resolve(process.cwd(), configuredPath)
  : path.resolve(webRoot, "../distributions/community/toss.json");
const distribution = JSON.parse(fs.readFileSync(configPath, "utf8"));
const included = distribution.frontend_features?.included;
if (!Array.isArray(included)) {
  throw new Error(`Invalid frontend feature configuration: ${configPath}`);
}

const outputDir = path.resolve(webRoot, "dist/_ai-runtime");
const webManifestPath = path.resolve(webRoot, "dist/toss-build-manifest.json");
const templatePath = path.resolve(webRoot, "ai-runtime/bootstrap.template.html");
const viteManifestPath = path.join(outputDir, "runtime-vite-manifest.json");
const browserTarget = process.env.TOSS_WEB_TARGET?.trim() === "browser";
const applicationBase = process.env.TOSS_BASE_URL?.trim() || "/";
const runtimeBase = `${applicationBase.endsWith("/") ? applicationBase : `${applicationBase}/`}_ai-runtime/`;
fs.rmSync(outputDir, { recursive: true, force: true });

const defaultCustomProfiles = {
  enabled: false,
  require_catalog_match: true,
  defaults: {
    context_window: 65_536,
    max_output_tokens: 8_192,
    reasoning: false,
    request_overrides: {}
  },
  limits: {
    min_context_window: 8_192,
    max_context_window: 4_194_304,
    min_output_tokens: 256,
    max_output_tokens: 1_048_576
  },
  max_saved_profiles: 20
};

function staticRuntimePolicy(policy) {
  if (policy?.kind === "user_defined") return { kind: "user_defined" };
  if (policy?.kind !== "managed_catalog") {
    throw new Error("Static AI Runtime requires a supported distribution connection policy");
  }
  const custom = policy.custom_profiles ?? defaultCustomProfiles;
  return {
    kind: "managed_catalog",
    provider: {
      id: policy.provider.id,
      label: policy.provider.label,
      credentialLabel: policy.provider.credential_label,
      protocol: policy.provider.protocol,
      baseUrl: policy.provider.base_url,
      catalog: policy.provider.catalog
    },
    defaultModelProfileId: policy.default_model_profile,
    modelProfiles: policy.model_profiles.map((profile) => ({
      id: profile.id,
      model: profile.model,
      label: profile.label,
      contextWindow: profile.context_window,
      maxOutputTokens: profile.max_output_tokens,
      reasoning: profile.reasoning,
      requestOverrides: profile.request_overrides ?? {}
    })),
    customProfiles: {
      enabled: custom.enabled,
      requireCatalogMatch: custom.require_catalog_match,
      defaults: {
        contextWindow: custom.defaults.context_window,
        maxOutputTokens: custom.defaults.max_output_tokens,
        reasoning: custom.defaults.reasoning,
        requestOverrides: custom.defaults.request_overrides ?? {}
      },
      limits: {
        minContextWindow: custom.limits.min_context_window,
        maxContextWindow: custom.limits.max_context_window,
        minOutputTokens: custom.limits.min_output_tokens,
        maxOutputTokens: custom.limits.max_output_tokens
      },
      maxSavedProfiles: custom.max_saved_profiles
    }
  };
}

function staticConnectSources(policy) {
  if (policy.kind === "user_defined") {
    return ["https:", "http://localhost:*", "http://127.0.0.1:*"];
  }
  const provider = new URL(policy.provider.baseUrl);
  if (provider.protocol !== "https:" || provider.username || provider.password) {
    throw new Error("Static managed AI Runtime requires a credential-free HTTPS provider");
  }
  return [provider.origin];
}

function outputFile(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new Error(`AI Runtime manifest contains an unsafe path: ${relativePath}`);
  }
  const resolved = path.resolve(outputDir, relativePath);
  const relative = path.relative(outputDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`AI Runtime manifest path escapes its output: ${relativePath}`);
  }
  return resolved;
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : entry.isFile() ? [target] : [];
  });
}

if (included.includes("ai_assistant")) {
  await build({ configFile: path.resolve(webRoot, "vite.ai-runtime.config.ts") });

  const webManifest = JSON.parse(fs.readFileSync(webManifestPath, "utf8"));
  const runtimeDescriptor = JSON.parse(
    fs.readFileSync(path.join(outputDir, "runtime-build.json"), "utf8")
  );
  if (
    webManifest.ai_runtime?.build_id !== runtimeDescriptor.build_id ||
    webManifest.ai_runtime?.entry_path !== "_ai-runtime/bootstrap.html"
  ) {
    throw new Error(
      "AI Runtime artifact does not match the main web build manifest; rebuild the complete web bundle"
    );
  }

  const viteManifest = JSON.parse(fs.readFileSync(viteManifestPath, "utf8"));
  const entries = Object.values(viteManifest).filter((entry) => entry?.isEntry === true);
  if (entries.length !== 1) {
    throw new Error(`AI Runtime build must emit one entry; found ${entries.length}`);
  }
  const entry = entries[0];
  const entryPath = outputFile(entry.file);
  if (!fs.statSync(entryPath).isFile()) {
    throw new Error(`AI Runtime entry is not a regular file: ${entry.file}`);
  }

  const unresolvedBuildGlobals = new Map();
  for (const file of listFiles(path.join(outputDir, "assets"))) {
    if (!file.endsWith(".js")) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /__TOSS_(?:BUILD_[A-Z0-9_]+|AI_RUNTIME_BUILD_ID)__/g
    )) {
      const name = path.relative(outputDir, file).split(path.sep).join("/");
      const files = unresolvedBuildGlobals.get(match[0]) ?? [];
      files.push(name);
      unresolvedBuildGlobals.set(match[0], files);
    }
  }
  if (unresolvedBuildGlobals.size > 0) {
    const details = [...unresolvedBuildGlobals]
      .map(([token, files]) => `${token} in ${[...new Set(files)].join(", ")}`)
      .join("; ");
    throw new Error(`AI Runtime contains unresolved build globals: ${details}`);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  let html;
  if (browserTarget) {
    const bundledFiles = listFiles(path.join(outputDir, "assets"));
    if (
      bundledFiles.length !== 1 ||
      path.resolve(bundledFiles[0]) !== path.resolve(entryPath) ||
      (entry.imports?.length ?? 0) !== 0
    ) {
      throw new Error("Static AI Runtime must be a single self-contained module");
    }
    const policy = staticRuntimePolicy(
      distribution.ai_assistant?.connection_policy
    );
    if (policy.kind !== runtimeDescriptor.connection_policy) {
      throw new Error("Static AI Runtime policy does not match its build descriptor");
    }
    const nonce = createHash("sha256")
      .update(runtimeDescriptor.build_id)
      .update("\0")
      .update(JSON.stringify(policy))
      .digest("base64url")
      .slice(0, 32);
    html = renderAiRuntimeEntry(template, {
      kind: "static",
      scriptSource: fs.readFileSync(entryPath, "utf8"),
      nonce,
      encodedPolicy: Buffer.from(JSON.stringify(policy)).toString("base64url"),
      connectSources: staticConnectSources(policy)
    });
    fs.rmSync(path.join(outputDir, "assets"), { recursive: true, force: true });
  } else {
    html = renderAiRuntimeEntry(template, {
      kind: "core",
      scriptSrc: `${runtimeBase}${entry.file}`
    });
  }
  fs.writeFileSync(path.join(outputDir, "bootstrap.html"), html);
  fs.rmSync(viteManifestPath, { force: true });
} else {
  const webManifest = JSON.parse(fs.readFileSync(webManifestPath, "utf8"));
  if (webManifest.ai_runtime !== null) {
    throw new Error(
      "The main web build manifest describes an AI Runtime excluded by the distribution"
    );
  }
}
