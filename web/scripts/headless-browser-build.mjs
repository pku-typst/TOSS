#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { DEFAULT_AI_RUNTIME_PREFERENCES } from "../src/features/ai/runtimePreferences.ts";
import { DEFAULT_RUNTIME_DESIGN_THEME } from "../src/design/runtimeTheme.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDirectory, "..");
const distRoot = path.join(webRoot, "dist");
const timeoutMs = 120_000;
const configuredFrontendFeatures =
  process.env.TOSS_BROWSER_ENABLED_FEATURES === undefined
    ? null
    : new Set(
        process.env.TOSS_BROWSER_ENABLED_FEATURES
          .split(",")
          .map((feature) => feature.trim())
          .filter(Boolean),
      );

function applicationBase() {
  const configured = process.env.TOSS_BASE_URL?.trim() || "/TOSS/";
  if (
    !configured.startsWith("/") ||
    configured.startsWith("//") ||
    configured.includes("?") ||
    configured.includes("#")
  ) {
    throw new Error(`TOSS_BASE_URL must be an absolute path: ${configured}`);
  }
  return configured.endsWith("/") ? configured : `${configured}/`;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(distRoot, relativePath), "utf8"));
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

async function startPreview(base) {
  const server = await preview({
    root: webRoot,
    configFile: false,
    base,
    logLevel: "error",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    server.httpServer.close();
    throw new Error("Static preview did not expose a TCP address");
  }
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function closePreview(server) {
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function installNetworkProbe(context, origin) {
  const coreRequests = [];
  const failedRequests = [];
  const failedResponses = [];

  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith("/v1/")) {
      coreRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  context.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText || "unknown";
    if (error !== "net::ERR_ABORTED") {
      failedRequests.push(`${url.origin}${url.pathname}: ${error}`);
    }
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${url.origin}${url.pathname}`);
    }
  });

  return () => {
    const failures = [];
    if (coreRequests.length > 0) {
      failures.push(`unexpected Core requests: ${coreRequests.join(", ")}`);
    }
    if (failedRequests.length > 0) {
      failures.push(`failed static requests: ${failedRequests.join(", ")}`);
    }
    if (failedResponses.length > 0) {
      failures.push(`failed static responses: ${failedResponses.join(", ")}`);
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
  };
}

function installPageProbe(page, label, failures) {
  page.on("pageerror", (error) => {
    failures.push(`${label} page error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`${label} console error: ${message.text()}`);
    }
  });
}

async function waitForCompiledPreview(page, previousCacheKey = null) {
  const selector = ".panel-preview .typst-page canvas[data-typst-ready='true']";
  await page.waitForFunction(
    ({ selector: candidateSelector, previous }) => {
      const canvas = document.querySelector(candidateSelector);
      if (!(canvas instanceof HTMLCanvasElement)) return false;
      const cacheKey = canvas.dataset.typstCacheKey;
      return Boolean(cacheKey) && (!previous || cacheKey !== previous);
    },
    { selector, previous: previousCacheKey },
    { timeout: timeoutMs },
  );
  const canvas = page.locator(selector).first();
  const cacheKey = await canvas.getAttribute("data-typst-cache-key");
  if (!cacheKey) throw new Error("Compiled Typst preview has no cache identity");
  const errorCount = await page
    .locator(
      ".panel-preview .compile-error-alert, .panel-preview .diagnostic-item[status='danger']",
    )
    .count();
  if (errorCount > 0) throw new Error("Typst preview contains compile errors");
  return cacheKey;
}

async function waitForIndexedDbContent(page, marker) {
  await page.waitForFunction(
    async (needle) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("toss-browser-backend");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const records = await new Promise((resolve, reject) => {
          const request = database
            .transaction("documents", "readonly")
            .objectStore("documents")
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return records.some(
          (record) =>
            typeof record?.content === "string" && record.content.includes(needle),
        );
      } finally {
        database.close();
      }
    },
    marker,
    { timeout: timeoutMs },
  );
}

async function runtimeIdentity(context, runtimeUrl, failures) {
  const page = await context.newPage();
  installPageProbe(page, "AI Runtime identity", failures);
  try {
    await page.goto(runtimeUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForFunction(
      () =>
        Boolean(document.documentElement.dataset.runtimeBuild) &&
        Boolean(document.documentElement.dataset.runtimeProtocol),
      undefined,
      { timeout: timeoutMs },
    );
    return page.evaluate(() => ({
      buildId: document.documentElement.dataset.runtimeBuild,
      protocolVersion: Number(document.documentElement.dataset.runtimeProtocol),
    }));
  } finally {
    await page.close();
  }
}

async function verifyOpaqueRuntimeHandshake(
  page,
  { entryPath, buildId, protocolVersion },
) {
  return page.evaluate(
    async ({ entryPath, buildId, protocolVersion, theme, preferences }) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.sandbox.add("allow-scripts");
      frame.src = new URL(entryPath, document.baseURI).toString();
      document.body.append(frame);

      let port;
      try {
        await new Promise((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("AI Runtime iframe load timed out")),
            30_000,
          );
          frame.addEventListener(
            "load",
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          frame.addEventListener(
            "error",
            () => {
              window.clearTimeout(timer);
              reject(new Error("AI Runtime iframe failed to load"));
            },
            { once: true },
          );
        });
        if (!frame.contentWindow) throw new Error("AI Runtime iframe has no window");

        let documentReadable = false;
        try {
          documentReadable = Boolean(frame.contentWindow.document);
        } catch {
          // Expected: the sandbox omits allow-same-origin.
        }
        if (documentReadable) {
          throw new Error("AI Runtime iframe is not opaque");
        }

        const sessionId = "static-browser-ci-session";
        const nonce = "static-browser-ci-nonce";
        const channel = new MessageChannel();
        port = channel.port1;
        const receivedMessages = [];
        const ready = new Promise((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("AI Runtime handshake timed out")),
            60_000,
          );
          port.addEventListener("message", (event) => {
            receivedMessages.push(event.data);
            if (event.data?.type === "toss.ai.runtime.error") {
              window.clearTimeout(timer);
              reject(
                new Error(
                  `AI Runtime rejected bootstrap: ${event.data.code || "unknown"}`,
                ),
              );
              return;
            }
            if (event.data?.type === "toss.ai.runtime.ready") {
              window.clearTimeout(timer);
              resolve(receivedMessages);
            }
          });
          port.start();
        });
        frame.contentWindow.postMessage(
          {
            type: "toss.ai.runtime.initialize",
            protocolVersion,
            buildId,
            sessionId,
            nonce,
            parentOrigin: window.location.origin,
            locale: "en",
            theme,
            preferences,
            connection: { kind: "fake" },
            conversation: {
              conversationId: "static-browser-ci-conversation",
              history: [],
            },
            workspace: null,
          },
          "*",
          [channel.port2],
        );
        const messages = await ready;
        port.postMessage({ type: "toss.ai.host.clear_session", sessionId });
        const acknowledgement = messages[0];
        const runtimeReady = messages.find(
          (message) => message?.type === "toss.ai.runtime.ready",
        );
        if (
          acknowledgement?.type !== "toss.ai.runtime.bootstrap_ack" ||
          acknowledgement.buildId !== buildId ||
          acknowledgement.protocolVersion !== protocolVersion ||
          acknowledgement.sessionId !== sessionId ||
          acknowledgement.nonce !== nonce ||
          !runtimeReady ||
          runtimeReady.buildId !== buildId ||
          runtimeReady.protocolVersion !== protocolVersion
        ) {
          throw new Error("AI Runtime returned an invalid handshake");
        }
        return messages.map((message) => message?.type).filter(Boolean);
      } finally {
        port?.close();
        frame.remove();
      }
    },
    {
      entryPath,
      buildId,
      protocolVersion,
      theme: DEFAULT_RUNTIME_DESIGN_THEME,
      preferences: DEFAULT_AI_RUNTIME_PREFERENCES,
    },
  );
}

async function main() {
  const base = applicationBase();
  const webManifest = requireObject(
    await readJson("toss-build-manifest.json"),
    "Web build manifest",
  );
  const runtimeDescriptor = requireObject(
    await readJson("_ai-runtime/runtime-build.json"),
    "AI Runtime build descriptor",
  );
  const runtimeManifest = requireObject(
    webManifest.ai_runtime,
    "Web AI Runtime manifest",
  );
  if (
    typeof runtimeManifest.entry_path !== "string" ||
    runtimeManifest.entry_path !== "_ai-runtime/bootstrap.html" ||
    runtimeManifest.build_id !== runtimeDescriptor.build_id
  ) {
    throw new Error("Static host and AI Runtime build descriptors do not match");
  }

  const { server, origin } = await startPreview(base);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const assertNetwork = installNetworkProbe(context, origin);
  const pageFailures = [];
  const page = await context.newPage();
  installPageProbe(page, "static application", pageFailures);
  const applicationUrl = `${origin}${base}`;
  const runtimeUrl = new URL(runtimeManifest.entry_path, applicationUrl).toString();

  try {
    await page.goto(applicationUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const marker = `STATIC-CI-${randomUUID()}`;
    const projectName = `Static browser CI ${marker.slice(-8)}`;
    await page.locator("input[name='project-name']").fill(projectName);
    await page.locator("[data-action='create-project']").click();
    const projectRow = page.locator(".projects-row").filter({ hasText: projectName });
    await projectRow.waitFor({ state: "visible", timeout: timeoutMs });
    await projectRow.locator("[data-action='open-project']").click();
    await page.waitForURL((url) => url.hash.startsWith("#/project/"), {
      timeout: timeoutMs,
    });

    const editor = page.locator(".cm-content[contenteditable='true']").first();
    await editor.waitFor({ state: "visible", timeout: timeoutMs });
    const initialCacheKey = await waitForCompiledPreview(page);
    const source = [
      "#set page(width: 240pt, height: 140pt, margin: 16pt)",
      "#set text(size: 12pt)",
      "",
      "= Static browser target",
      "",
      `Persistence marker: ${marker}.`,
      "",
    ].join("\n");
    await editor.fill(source);
    await page.waitForFunction(
      (needle) => document.querySelector(".cm-content")?.textContent?.includes(needle),
      marker,
      { timeout: timeoutMs },
    );
    await waitForCompiledPreview(page, initialCacheKey);
    await waitForIndexedDbContent(page, marker);

    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    const reloadedEditor = page.locator(".cm-content[contenteditable='true']").first();
    await reloadedEditor.waitFor({ state: "visible", timeout: timeoutMs });
    await page.waitForFunction(
      (needle) => document.querySelector(".cm-content")?.textContent?.includes(needle),
      marker,
      { timeout: timeoutMs },
    );
    await waitForCompiledPreview(page);

    if (configuredFrontendFeatures !== null) {
      const assistantControlCount = await page
        .locator('[data-panel-toggle="feature:ai_assistant"]')
        .count();
      const assistantExpected = configuredFrontendFeatures.has("ai_assistant");
      const expectedControlCount = assistantExpected ? 1 : 0;
      if (assistantControlCount !== expectedControlCount) {
        throw new Error(
          `Assistant control does not match static feature selection: expected=${expectedControlCount}, actual=${assistantControlCount}`,
        );
      }
    }

    const identity = await runtimeIdentity(context, runtimeUrl, pageFailures);
    if (
      identity.buildId !== runtimeManifest.build_id ||
      !Number.isSafeInteger(identity.protocolVersion) ||
      identity.protocolVersion < 1
    ) {
      throw new Error("AI Runtime identity does not match the static host manifest");
    }
    const handshake = await verifyOpaqueRuntimeHandshake(page, {
      entryPath: runtimeManifest.entry_path,
      buildId: identity.buildId,
      protocolVersion: identity.protocolVersion,
    });
    if (
      handshake[0] !== "toss.ai.runtime.bootstrap_ack" ||
      !handshake.includes("toss.ai.runtime.ready")
    ) {
      throw new Error(`AI Runtime handshake sequence is invalid: ${handshake.join(", ")}`);
    }

    assertNetwork();
    if (pageFailures.length > 0) throw new Error(pageFailures.join("; "));
    console.log("[browser-build] project, compile, persistence, isolation, and no-Core smoke passed");
  } finally {
    await context.close();
    await browser.close();
    await closePreview(server);
  }
}

await main();
