#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { promisify } from "node:util";
import { createServer as createViteServer } from "vite";

const execFileAsync = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function booleanEnvironment(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function requestOverridesEnvironment() {
  const raw = process.env.AI_PROVIDER_REQUEST_OVERRIDES?.trim() || "{}";
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("AI_PROVIDER_REQUEST_OVERRIDES must be a JSON object");
  }
  return value;
}

function commaSeparatedEnvironment(name) {
  const raw = process.env[name]?.trim();
  return raw ? [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))] : [];
}

function stringArrayEnvironment(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }
  return value;
}

async function startPackageFixtureEndpoint(packageSpec, archivePath) {
  const match = /^@(local|preview)\/([^:]+):(.+)$/.exec(packageSpec);
  if (!match) throw new Error("AI_SCENARIO_PACKAGE_SPEC must be an exact Typst package spec");
  const [, namespace, name, version] = match;
  const archive = await readFile(archivePath);
  const digest = createHash("sha256").update(archive).digest("hex");
  const expectedPath = `/v1/typst/packages/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== expectedPath) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": archive.byteLength,
      "x-typst-package-sha256": digest
    });
    response.end(archive);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The package fixture endpoint did not expose a TCP address");
  }
  server.unref();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    digest: `sha256:${digest}`,
    bytes: archive.byteLength,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

function normalizeProviderBaseUrl(raw, protocol) {
  const url = new URL(raw);
  if (protocol === "openai-completions") {
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "");
  } else if (protocol === "openai-responses") {
    url.pathname = url.pathname.replace(/\/responses\/?$/, "");
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

const providerProtocol = process.env.AI_PROVIDER_PROTOCOL?.trim() || "openai-completions";
const supportedProtocols = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages"
]);
if (!supportedProtocols.has(providerProtocol)) {
  throw new Error(`Unsupported AI_PROVIDER_PROTOCOL: ${providerProtocol}`);
}

const credentialFile = requiredEnvironment("AI_PROVIDER_CREDENTIAL_FILE");
const credential = (await readFile(credentialFile, "utf8")).trim();
if (!credential) throw new Error("AI_PROVIDER_CREDENTIAL_FILE is empty");

const connection = {
  kind: "endpoint",
  connectionId: "local-agent-scenario",
  protocol: providerProtocol,
  baseUrl: normalizeProviderBaseUrl(requiredEnvironment("AI_PROVIDER_BASE_URL"), providerProtocol),
  model: requiredEnvironment("AI_PROVIDER_MODEL"),
  contextWindow: positiveIntegerEnvironment("AI_CONTEXT_WINDOW", 32_768),
  maxOutputTokens: positiveIntegerEnvironment("AI_MAX_OUTPUT_TOKENS", 4_096),
  reasoning: booleanEnvironment("AI_REASONING", false),
  requestOverrides: requestOverridesEnvironment()
};

const prompt = process.env.AI_SCENARIO_PROMPT?.trim() || [
  "请读取当前 Typst 项目并实际修改 main.typ。",
  "为文档补充 metadata：title 使用现有一级标题，author 设为 TOSS Community Team，",
  "date 设为 datetime(year: 2026, month: 7, day: 15)，keywords 包含 TOSS、Typst、collaboration。",
  "不要改变正文内容；完成后确认候选版本编译通过。"
].join("");
const systemPromptAppend = process.env.AI_SCENARIO_SYSTEM_APPEND?.trim() || "";
const expectReview = booleanEnvironment("AI_SCENARIO_EXPECT_REVIEW", true);
const requiredTools = commaSeparatedEnvironment("AI_SCENARIO_REQUIRED_TOOLS");
const requiredOutputSubstrings = stringArrayEnvironment(
  "AI_SCENARIO_REQUIRED_OUTPUT_SUBSTRINGS"
);
const packageSpec = process.env.AI_SCENARIO_PACKAGE_SPEC?.trim() || "";
const packageArchivePath = process.env.AI_SCENARIO_PACKAGE_ARCHIVE?.trim() || "";
if (Boolean(packageSpec) !== Boolean(packageArchivePath)) {
  throw new Error(
    "AI_SCENARIO_PACKAGE_SPEC and AI_SCENARIO_PACKAGE_ARCHIVE must be provided together"
  );
}

const initialDocuments = {
  "main.typ": [
    "#import \"theme.typ\": accent, callout",
    "",
    "#set page(paper: \"a4\", margin: (x: 24mm, y: 22mm))",
    "#set text(size: 10.5pt)",
    "#show heading: set text(fill: accent)",
    "",
    "= Collaborative Typesetting Study",
    "",
    "#callout[",
    "  This synthetic project exercises a realistic multi-file Typst workspace.",
    "]",
    "",
    "== Abstract",
    "",
    "This report studies deterministic document collaboration, isolated candidate",
    "compilation, and reviewable machine-generated edits.",
    "",
    "#outline(title: [Contents])",
    "",
    "#include \"sections/method.typ\"",
    "",
    "#include \"sections/results.typ\"",
    "",
    "== Conclusion",
    "",
    "A useful assistant must inspect real project state, propose a bounded change,",
    "and verify the candidate before claiming success.",
    ""
  ].join("\n"),
  "theme.typ": [
    "#let accent = rgb(\"#2457a6\")",
    "#let callout(body) = block(",
    "  fill: rgb(\"#eef4ff\"),",
    "  stroke: (left: 2pt + accent),",
    "  inset: 10pt,",
    "  width: 100%,",
    "  body,",
    ")",
    ""
  ].join("\n"),
  "sections/method.typ": [
    "== Method",
    "",
    "The workflow separates source inspection, patch construction, isolated",
    "compilation, and human review into explicit stages.",
    "",
    "+ Read a snapshot of the active source.",
    "+ Construct a contextual unified diff.",
    "+ Compile an isolated candidate World.",
    "+ Present a verified proposal for review.",
    ""
  ].join("\n"),
  "sections/results.typ": [
    "== Results",
    "",
    "#table(",
    "  columns: (1fr, auto),",
    "  [Stage], [Expected property],",
    "  [Read], [Snapshot-bound],",
    "  [Edit], [Reviewable],",
    "  [Verify], [Compiler-backed],",
    ")",
    ""
  ].join("\n")
};
if (packageSpec) {
  initialDocuments["main.typ"] = [
    `#import "${packageSpec}" as inspected_package`,
    initialDocuments["main.typ"]
  ].join("\n");
}

const packageFixtureEndpoint = packageSpec
  ? await startPackageFixtureEndpoint(packageSpec, packageArchivePath)
  : null;
const packageDigestPlaceholder = "{{PACKAGE_DIGEST}}";
if (
  requiredOutputSubstrings.some((value) => value.includes(packageDigestPlaceholder)) &&
  !packageFixtureEndpoint
) {
  throw new Error(
    "AI_SCENARIO_REQUIRED_OUTPUT_SUBSTRINGS uses {{PACKAGE_DIGEST}} without a package fixture"
  );
}
const resolvedRequiredOutputSubstrings = requiredOutputSubstrings.map((value) =>
  value.replaceAll(packageDigestPlaceholder, packageFixtureEndpoint?.digest ?? "")
);

const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  connection: {
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    contextWindow: connection.contextWindow,
    maxOutputTokens: connection.maxOutputTokens,
    reasoning: connection.reasoning,
    requestOverrides: connection.requestOverrides
  },
  prompt,
  providerCalls: [],
  providerResponses: [],
  agentToolCalls: [],
  toolCalls: [],
  proposals: [],
  reviewHandoff: null,
  content: [],
  usage: [],
  result: null,
  finalCompile: null,
  finalMainTyp: null,
  packageFixture: packageFixtureEndpoint ? {
    packageSpec,
    digest: packageFixtureEndpoint.digest,
    bytes: packageFixtureEndpoint.bytes
  } : null,
  validation: null
};

function redact(value) {
  if (typeof value === "string") return value.replaceAll(credential, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
}

function printable(value) {
  return JSON.stringify(redact(value), null, 2);
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return {
    model: payload.model,
    messageRoles: messages.map((message) => message?.role ?? "unknown"),
    messageCharacters: messages.map((message) => {
      const content = message?.content;
      return typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
    }),
    tools: tools.map((tool) => tool?.function?.name ?? tool?.name ?? "unknown"),
    stream: payload.stream,
    maxTokens: payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens,
    temperature: payload.temperature,
    reasoning: payload.reasoning,
    reasoningEffort: payload.reasoning_effort,
    enableThinking: payload.enable_thinking,
    chatTemplateKwargs: payload.chat_template_kwargs
  };
}

function summarizeProviderMessage(message) {
  return {
    stopReason: message?.stopReason,
    errorMessage: message?.errorMessage,
    usage: message?.usage,
    content: Array.isArray(message?.content) ? message.content : []
  };
}

async function writeProject(root, documents) {
  for (const [path, text] of Object.entries(documents)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text, "utf8");
  }
}

async function compileDocuments(documents) {
  const root = await mkdtemp(join(tmpdir(), "toss-ai-agent-"));
  try {
    await writeProject(root, documents);
    try {
      await execFileAsync(
        process.env.TYPST_BIN || "typst",
        ["compile", "--diagnostic-format", "short", "--root", root, "main.typ", "output.pdf"],
        { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }
      );
      return { passed: true, diagnostics: "" };
    } catch (error) {
      const diagnostics = [error?.stdout, error?.stderr, error?.message]
        .filter(Boolean)
        .join("\n")
        .trim();
      return { passed: false, diagnostics };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const state = {
  documents: { ...initialDocuments },
  identities: Object.fromEntries(Object.keys(initialDocuments).map((path, index) => [path, {
    id: `document-${index + 1}`,
    pathRevision: 1,
    collaborationRevision: 1
  }]))
};
const nodes = [
  { path: "main.typ", kind: "file" },
  { path: "theme.typ", kind: "file" },
  { path: "sections", kind: "directory" },
  { path: "sections/method.typ", kind: "file" },
  { path: "sections/results.typ", kind: "file" }
];

function source() {
  return {
    scopeId: "local-agent-project",
    projectType: "typst",
    mode: "live",
    entryFilePath: "main.typ",
    activePath: "main.typ",
    nodes,
    documents: state.documents,
    activeDocument: { path: "main.typ", text: state.documents["main.typ"] },
    documentIdentities: state.identities
  };
}

function contextSnapshot() {
  return {
    schema: 1,
    project_name: "Synthetic Agent Modification Scenario",
    project_type: "typst",
    mode: "live",
    entry_file_path: "main.typ",
    active_path: "main.typ",
    access: "edit",
    workspace_state: "ready",
    active_document_state: "ready",
    files: { total: nodes.filter(({ kind }) => kind === "file").length, text: 4, assets: 0 },
    compilation: { state: "succeeded", errors: 0, warnings: 0 },
    pending_edit_review: false,
    last_edit_review: null
  };
}

const baselineCompile = await compileDocuments(state.documents);
if (!baselineCompile.passed) {
  throw new Error(`Synthetic Typst fixture does not compile:\n${baselineCompile.diagnostics}`);
}

const vite = await createViteServer({
  root: webRoot,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  define: {
    __TOSS_AI_RUNTIME_BUILD_ID__: JSON.stringify("local-agent-scenario")
  },
  resolve: {
    alias: { "@": resolve(webRoot, "src") }
  },
  server: { middlewareMode: true }
});

const channel = new MessageChannel();
let toolBridge;
let workspacePort;
let latestCompileRevision = null;
let pendingReview = null;
const activeToolCalls = new Map();

try {
  const [
    agentModule,
    providerModule,
    bridgeModule,
    toolsModule,
    promptModule,
    workspaceModule,
    packageArchiveModule
  ] =
    await Promise.all([
      vite.ssrLoadModule("/src/ai-runtime/agentSession.ts"),
      vite.ssrLoadModule("/src/ai-runtime/providerAdapter.ts"),
      vite.ssrLoadModule("/src/ai-runtime/toolBridge.ts"),
      vite.ssrLoadModule("/src/ai-runtime/runtimeTools.ts"),
      vite.ssrLoadModule("/src/ai-runtime/i18n.ts"),
      vite.ssrLoadModule("/src/pages/workspace/assistantWorkspacePort.ts"),
      vite.ssrLoadModule("/src/features/ai/typstPackageArchive.ts")
    ]);

  const loadedPackages = new Map();
  const packageInspector = packageFixtureEndpoint ? {
    async execute(request, signal) {
      try {
        const requestedSpec = request.arguments.package_spec;
        let loadedPackage = loadedPackages.get(requestedSpec);
        if (!loadedPackage) {
          loadedPackage = await packageArchiveModule.fetchTypstPackage(
            packageFixtureEndpoint.baseUrl,
            requestedSpec,
            signal
          );
          loadedPackages.set(requestedSpec, loadedPackage);
        }
        const result = request.tool === "list_typst_package_files"
          ? packageArchiveModule.listTypstPackageFiles(loadedPackage, request.arguments)
          : request.tool === "read_typst_package_file"
            ? packageArchiveModule.readTypstPackageFile(loadedPackage, request.arguments)
            : packageArchiveModule.searchTypstPackageText(
                loadedPackage,
                request.arguments,
                signal
              );
        return { outcome: "success", result };
      } catch (error) {
        if (error instanceof packageArchiveModule.TypstPackageInspectionError) {
          return {
            outcome: "error",
            error: { code: error.code, message: error.message }
          };
        }
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return {
            outcome: "error",
            error: {
              code: "workspace_request_cancelled",
              message: "The Typst package inspection was cancelled."
            }
          };
        }
        return {
          outcome: "error",
          error: {
            code: "typst_package_internal_error",
            message: "The Typst package could not be inspected safely."
          }
        };
      }
    },
    dispose() {}
  } : undefined;

  workspacePort = workspaceModule.createAiWorkspacePort({
    scopeId: "local-agent-project",
    projectType: "typst",
    mode: "live",
    allowEdits: true,
    typstPackageInspector: packageInspector,
    getContextSnapshot: contextSnapshot,
    getCompilationSnapshot: () => ({
      state: "succeeded",
      diagnosticsCurrent: true,
      errors: [],
      diagnostics: []
    }),
    getSource: source,
    verifyCandidate: async ({ path, candidateText }) => {
      const candidateDocuments = { ...state.documents, [path]: candidateText };
      const compiled = await compileDocuments(candidateDocuments);
      latestCompileRevision = { id: crypto.randomUUID() };
      if (compiled.passed) {
        return { outcome: "completed", revision: latestCompileRevision, errors: [], diagnostics: [] };
      }
      return {
        outcome: "completed",
        revision: latestCompileRevision,
        errors: [compiled.diagnostics],
        diagnostics: [{ severity: "error", message: compiled.diagnostics, path }]
      };
    },
    isCandidateRevisionCurrent: (revision) => revision === latestCompileRevision,
    requestEditReview: (proposal) => {
      if (pendingReview) {
        throw new Error("The headless scenario received more than one pending edit review");
      }
      const reviewId = `local-review-${report.proposals.length + 1}`;
      report.proposals.push({
        editKind: proposal.editKind,
        path: proposal.path,
        patch: proposal.patch,
        addedLines: proposal.addedLines,
        removedLines: proposal.removedLines,
        hunkCount: proposal.hunkCount,
        verification: proposal.verification
      });
      pendingReview = {
        reviewId,
        proposal,
        providerCallsAtHandoff: report.providerCalls.length
      };
      console.log(`[review] pending ${proposal.path} (${proposal.addedLines}+/${proposal.removedLines}-)`);
      return { outcome: "pending", reviewId };
    }
  });

  toolBridge = new bridgeModule.AiRuntimeToolBridge(
    channel.port1,
    "local-agent-session",
    () => "zh-CN"
  );

  channel.port1.on("message", (message) => {
    if (message?.type === "toss.ai.host.tool_result") toolBridge.handleResult(message);
  });
  channel.port2.on("message", async (message) => {
    if (message?.type === "toss.ai.runtime.tool_cancel") {
      activeToolCalls.get(message.callId)?.abort();
      return;
    }
    if (message?.type !== "toss.ai.runtime.tool_call") return;
    const controller = new AbortController();
    activeToolCalls.set(message.callId, controller);
    const entry = {
      index: report.toolCalls.length + 1,
      tool: message.tool,
      arguments: message.arguments,
      response: null
    };
    report.toolCalls.push(entry);
    console.log(`[tool ${entry.index}] ${entry.tool}\n${printable(entry.arguments)}`);
    try {
      entry.response = await workspacePort.execute({
        tool: message.tool,
        arguments: message.arguments
      }, controller.signal);
    } catch (error) {
      entry.response = {
        outcome: "error",
        error: { code: "workspace_tool_internal_error", message: String(error) }
      };
    } finally {
      activeToolCalls.delete(message.callId);
    }
    console.log(`[tool ${entry.index} result]\n${printable(entry.response)}`);
    channel.port2.postMessage({
      type: "toss.ai.host.tool_result",
      sessionId: "local-agent-session",
      turnId: message.turnId,
      callId: message.callId,
      tool: message.tool,
      response: entry.response
    });
  });

  const providerStream = await providerModule.loadAiProviderStream(connection.protocol);
  const tracedStream = (model, context, options) => {
    const call = {
      index: report.providerCalls.length + 1,
      messages: context.messages.length,
      tools: context.tools?.map(({ name }) => name) ?? [],
      payload: null
    };
    report.providerCalls.push(call);
    console.log(`[provider ${call.index}] ${call.messages} messages; tools=${call.tools.join(",")}`);
    const upstreamOnPayload = options?.onPayload;
    const streamOrPromise = providerStream(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const transformed = await upstreamOnPayload?.(payload, payloadModel);
        const finalPayload = transformed === undefined ? payload : transformed;
        call.payload = summarizePayload(finalPayload);
        console.log(`[provider ${call.index} payload]\n${printable(call.payload)}`);
        return finalPayload;
      }
    });
    void Promise.resolve(streamOrPromise)
      .then((stream) => stream.result())
      .then((message) => {
        const summary = { index: call.index, ...summarizeProviderMessage(message) };
        report.providerResponses.push(summary);
        console.log(`[provider ${call.index} response]\n${printable(summary)}`);
      })
      .catch((error) => {
        const summary = { index: call.index, streamError: String(error) };
        report.providerResponses.push(summary);
        console.log(`[provider ${call.index} stream error]\n${printable(summary)}`);
      });
    return streamOrPromise;
  };

  const baseTools = toolsModule.createAiRuntimeTools(
    workspacePort.capabilities,
    toolBridge,
    "zh-CN"
  );
  const tools = baseTools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, parameters, signal, onUpdate) => {
      const entry = {
        index: report.agentToolCalls.length + 1,
        tool: tool.name,
        toolCallId,
        arguments: parameters,
        outcome: "running",
        result: null,
        error: null
      };
      report.agentToolCalls.push(entry);
      console.log(`[agent tool ${entry.index}] ${entry.tool}\n${printable(parameters)}`);
      try {
        entry.result = await tool.execute(toolCallId, parameters, signal, onUpdate);
        entry.outcome = "success";
        console.log(`[agent tool ${entry.index} result]\n${printable(entry.result)}`);
        return entry.result;
      } catch (error) {
        entry.outcome = "error";
        entry.error = error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "Error", message: String(error) };
        console.log(`[agent tool ${entry.index} error]\n${printable(entry.error)}`);
        throw error;
      }
    }
  }));
  const session = new agentModule.AiAgentSession({
    connection,
    credential,
    conversationId: "local-modification",
    history: [],
    stream: tracedStream,
    systemPrompt: [
      promptModule.aiSystemPrompt(
        "zh-CN",
        workspacePort.capabilities,
        workspacePort.getContextSnapshot()
      ),
      systemPromptAppend
    ].filter(Boolean).join("\n\n"),
    tools,
    onContent: (turnId, event) => {
      report.content.push({ turnId, ...event });
      if (event.type === "delta") process.stdout.write(event.delta);
    },
    onUsage: (turnId, usage) => {
      report.usage.push({ turnId, ...usage });
    }
  });

  const turnId = `local-turn-${Date.now()}`;
  toolBridge.beginTurn(turnId);
  try {
    report.result = await session.prompt(turnId, prompt);
  } finally {
    toolBridge.endTurn(turnId);
    session.dispose();
  }
  process.stdout.write("\n");

  const validationErrors = [];
  if (pendingReview) {
    report.reviewHandoff = {
      reviewId: pendingReview.reviewId,
      statusAfterTurn: "pending",
      providerCallsAtHandoff: pendingReview.providerCallsAtHandoff,
      providerCallsAfterTurn: report.providerCalls.length
    };
    if (report.providerCalls.length !== pendingReview.providerCallsAtHandoff) {
      validationErrors.push("The Agent called the provider again after handing off an edit review");
    }
    if (expectReview) {
      const acceptedProposal = pendingReview.proposal;
      state.documents = {
        ...state.documents,
        [acceptedProposal.path]: acceptedProposal.candidateText
      };
      const acceptedIdentity = state.identities[acceptedProposal.path];
      state.identities = {
        ...state.identities,
        [acceptedProposal.path]: {
          ...acceptedIdentity,
          pathRevision: acceptedIdentity.pathRevision + 1,
          collaborationRevision: acceptedIdentity.collaborationRevision + 1
        }
      };
      console.log(`[review] accepted ${acceptedProposal.path} after Agent turn`);
    } else {
      validationErrors.push("The read-only scenario unexpectedly handed off an edit review");
    }
  } else if (expectReview) {
    validationErrors.push("The Agent turn ended without handing off an edit review");
  }

  report.finalCompile = await compileDocuments(state.documents);
  report.finalMainTyp = state.documents["main.typ"];
  const successfulToolNames = new Set(
    report.agentToolCalls
      .filter((entry) => entry.outcome === "success")
      .map((entry) => entry.tool)
  );
  const availableToolNames = new Set(baseTools.map((tool) => tool.name));
  const unavailableRequiredTools = requiredTools.filter((tool) => !availableToolNames.has(tool));
  const missingRequiredTools = requiredTools.filter((tool) => !successfulToolNames.has(tool));
  if (unavailableRequiredTools.length > 0) {
    validationErrors.push(
      `Required tools were not exposed: ${unavailableRequiredTools.join(", ")}`
    );
  }
  if (missingRequiredTools.length > 0) {
    validationErrors.push(
      `Required tools did not complete successfully: ${missingRequiredTools.join(", ")}`
    );
  }
  const failedToolCalls = report.agentToolCalls.filter((entry) => entry.outcome === "error");
  if (failedToolCalls.length > 0) {
    validationErrors.push(
      `Agent tool calls failed: ${failedToolCalls.map((entry) => entry.tool).join(", ")}`
    );
  }
  const assistantOutput = report.content
    .filter((event) => event.type === "delta")
    .map((event) => event.delta)
    .join("");
  const missingOutputSubstrings = resolvedRequiredOutputSubstrings.filter(
    (substring) => !assistantOutput.includes(substring)
  );
  if (missingOutputSubstrings.length > 0) {
    validationErrors.push(
      `Assistant output omitted required evidence: ${missingOutputSubstrings.join(", ")}`
    );
  }
  if (report.result?.outcome !== "completed") {
    validationErrors.push(`Agent outcome was ${report.result?.outcome ?? "missing"}`);
  }
  if (expectReview && report.proposals.length === 0) {
    validationErrors.push("The editing scenario produced no proposal");
  }
  if (!expectReview && report.proposals.length > 0) {
    validationErrors.push("The read-only scenario produced an edit proposal");
  }
  if (!report.finalCompile.passed) {
    validationErrors.push("The final Typst project did not compile");
  }
  report.validation = {
    passed: validationErrors.length === 0,
    expectReview,
    requiredTools,
    successfulTools: [...successfulToolNames],
    unavailableRequiredTools,
    missingRequiredTools,
    failedToolCalls: failedToolCalls.map((entry) => entry.index),
    requiredOutputSubstrings: resolvedRequiredOutputSubstrings,
    missingOutputSubstrings,
    errors: validationErrors
  };
  report.finishedAt = new Date().toISOString();

  const reportPath = process.env.AI_SCENARIO_REPORT?.trim() ||
    join(tmpdir(), `toss-ai-agent-scenario-${Date.now()}.json`);
  await writeFile(reportPath, printable(report), { encoding: "utf8", mode: 0o600 });

  console.log(`[result] ${printable(report.result)}`);
  console.log(`[result] accepted proposals=${report.proposals.length}`);
  console.log(`[result] final compile=${report.finalCompile.passed ? "passed" : "failed"}`);
  console.log(`[result] validation=${report.validation.passed ? "passed" : "failed"}`);
  console.log(`[result] trace=${reportPath}`);

  if (!report.validation.passed) process.exitCode = 1;
} finally {
  for (const controller of activeToolCalls.values()) controller.abort();
  toolBridge?.dispose();
  workspacePort?.dispose();
  channel.port1.close();
  channel.port2.close();
  await vite.close();
  await packageFixtureEndpoint?.close();
}
