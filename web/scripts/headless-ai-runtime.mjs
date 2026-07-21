import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const runId = Date.now().toString();
const email = `ai-runtime-${runId}@example.com`;
const password = "Runtime1234!";
const mockRuntimeCredential = "runtime-smoke-credential";
const externalProviderBaseUrl = process.env.AI_PROVIDER_BASE_URL;
const externalProviderProtocol = process.env.AI_PROVIDER_PROTOCOL;
const externalProviderModel = process.env.AI_PROVIDER_MODEL;
const externalProviderCredentialFile = process.env.AI_PROVIDER_CREDENTIAL_FILE;
const screenshotPath = process.env.AI_ASSISTANT_SCREENSHOT_PATH;
const providerProtocols = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJsonObject(raw, label) {
  assert(typeof raw === "string", `${label} is not JSON text`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is not a JSON object`);
  return value;
}

function workspaceContextFromPrompt(prompt) {
  assert(typeof prompt === "string", "system prompt is unavailable");
  const opening = "<workspace_context>\n";
  const closing = "\n</workspace_context>";
  const start = prompt.indexOf(opening);
  const end = prompt.indexOf(closing, start + opening.length);
  assert(start >= 0 && end > start, "system prompt has no Workspace context envelope");
  assert(prompt.indexOf(opening, start + opening.length) < 0, "system prompt repeats the Workspace context envelope");
  return parseJsonObject(prompt.slice(start + opening.length, end), "Workspace context");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startMockProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? "null";
    const requestedHeaders = request.headers["access-control-request-headers"];
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": requestedHeaders ?? "authorization, content-type",
      "access-control-expose-headers": "content-type",
      vary: "origin"
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      origin,
      authorization: request.headers.authorization,
      body
    });
    const turn = requests.length;
    response.writeHead(200, {
      ...cors,
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8"
    });
    const event = (delta, finishReason = null) => ({
      id: `mock-${turn}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason
      }]
    });
    if (turn === 1) {
      await delay(220);
      response.write(`data: ${JSON.stringify(event({
        tool_calls: [{
          index: 0,
          id: "mock-read-main",
          type: "function",
          function: {
            name: "read_project_file",
            arguments: "{\"path\":\"main.typ\",\"start_line\":1,\"end_line\":20}"
          }
        }]
      }))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, "tool_calls"))}\n\n`);
    } else if (turn === 2 || turn === 3) {
      const readToolMessage = body.messages.find((message) => message.role === "tool");
      let snapshotId = "missing-snapshot";
      try {
        snapshotId = JSON.parse(readToolMessage?.content ?? "{}").snapshot_id ?? snapshotId;
      } catch {
        // A malformed result deliberately causes the Host snapshot fence to reject the patch.
      }
      const patch = turn === 2 ? [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,3 +1,5 @@",
        "+#let broken = (",
        "+",
        " = Welcome to Typst Collaboration",
        " ",
        " This project is ready for collaborative Typst editing."
      ].join("\n") : [
        "--- a/main.typ",
        "+++ b/main.typ",
        "@@ -1,3 +1,8 @@",
        "+#set document(",
        "+  title: [AI Runtime Smoke],",
        "+  author: \"TOSS Assistant\",",
        "+)",
        "+",
        " = Welcome to Typst Collaboration",
        " ",
        " This project is ready for collaborative Typst editing."
      ].join("\n");
      response.write(`data: ${JSON.stringify(event({
        tool_calls: [{
          index: 0,
          id: turn === 2 ? "mock-apply-invalid" : "mock-apply-main",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              path: "main.typ",
              base_snapshot: snapshotId,
              patch
            })
          }
        }]
      }))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, "tool_calls"))}\n\n`);
    } else if (turn === 6) {
      response.write(`data: ${JSON.stringify(event({
        tool_calls: [{
          index: 0,
          id: "mock-query-typst-docs",
          type: "function",
          function: {
            name: "query_typst_docs",
            arguments: JSON.stringify({
              query: "math equation syntax",
              limit: 3
            })
          }
        }]
      }))}\n\n`);
      response.write(`data: ${JSON.stringify(event({}, "tool_calls"))}\n\n`);
    } else {
      const content = turn === 4
        ? "Workspace tool read main.typ and the reviewed metadata patch was accepted."
        : turn === 5
          ? "Mock provider turn 5 completed. Inline math: $E = mc^2$.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$"
        : turn === 7
          ? "Typst documentation query completed."
        : `Mock provider turn ${turn} completed.`;
      if (turn === 4) {
        await delay(220);
        response.write(`data: ${JSON.stringify(event({
          reasoning_content: "Checking the accepted patch and current project state."
        }))}\n\n`);
        await delay(220);
        response.write(`data: ${JSON.stringify(event({ content: content.slice(0, 28) }))}\n\n`);
        await delay(180);
        response.write(`data: ${JSON.stringify(event({ content: content.slice(28) }))}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify(event({ content }))}\n\n`);
      }
      response.write(`data: ${JSON.stringify(event({}, "stop"))}\n\n`);
    }
    response.write(`data: ${JSON.stringify({
      id: `mock-${turn}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [],
      usage: {
        prompt_tokens: 900 + turn * 100,
        completion_tokens: 50,
        total_tokens: 950 + turn * 100,
        completion_tokens_details: { reasoning_tokens: turn === 4 ? 20 : 0 }
      }
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider address unavailable");
  return {
    kind: "mock",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: "openai-completions",
    model: "mock-model",
    credential: mockRuntimeCredential,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function externalProvider() {
  const configured = [
    externalProviderBaseUrl,
    externalProviderProtocol,
    externalProviderModel,
    externalProviderCredentialFile
  ];
  if (configured.every((value) => value === undefined)) return null;
  if (configured.some((value) => !value)) {
    throw new Error("External provider mode requires base URL, protocol, model, and credential file");
  }
  if (!providerProtocols.has(externalProviderProtocol)) {
    throw new Error(`Unsupported external provider protocol: ${externalProviderProtocol}`);
  }
  const credential = (await readFile(externalProviderCredentialFile, "utf8")).trim();
  if (!credential) throw new Error("External provider credential file is empty");
  return {
    kind: "external",
    baseUrl: externalProviderBaseUrl,
    protocol: externalProviderProtocol,
    model: externalProviderModel,
    credential,
    requests: [],
    close: async () => undefined
  };
}

async function jsonResponse(response, operation) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${text}`);
  }
  return payload;
}

async function createFixture() {
  const auth = await jsonResponse(
    await fetch(`${coreApi}/v1/auth/local/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        username: `ai-runtime-${runId}`.slice(0, 32),
        display_name: "AI Runtime Test"
      })
    }),
    "register"
  );
  return jsonResponse(
    await fetch(`${coreApi}/v1/projects`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.session_token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: `AI Runtime ${runId}` })
    }),
    "create project"
  );
}

function nonceFromHtml(html) {
  return html.match(/\bnonce="([a-f0-9]+)"/)?.[1] ?? null;
}

async function verifyHttpBoundary() {
  const appResponse = await fetch(`${baseUrl}/`);
  assert(appResponse.ok, "application entry is unavailable");
  const appCsp = appResponse.headers.get("content-security-policy") ?? "";
  assert(appCsp.includes("frame-src 'self'"), "application CSP does not constrain frames");
  assert(
    !appCsp.includes("connect-src https:"),
    "application CSP unexpectedly grants arbitrary provider network access"
  );

  const first = await fetch(`${baseUrl}/_ai-runtime/bootstrap.html`);
  const second = await fetch(`${baseUrl}/_ai-runtime/bootstrap.html`);
  assert(first.ok && second.ok, "AI Runtime entry is unavailable");
  const firstHtml = await first.text();
  const secondHtml = await second.text();
  const firstNonce = nonceFromHtml(firstHtml);
  const secondNonce = nonceFromHtml(secondHtml);
  assert(firstNonce && secondNonce && firstNonce !== secondNonce, "Runtime nonce is not per response");
  assert(
    !firstHtml.includes("__TOSS_AI_RUNTIME_NONCE__"),
    "Runtime response exposes its nonce marker"
  );
  assert(
    (first.headers.get("content-security-policy") ?? "").includes("sandbox allow-scripts"),
    "Runtime response is missing its sandbox CSP"
  );
  assert(
    (first.headers.get("content-security-policy") ?? "").includes(`'nonce-${firstNonce}'`),
    "Runtime script nonce and CSP do not match"
  );
  assert(first.headers.get("cache-control") === "no-store", "Runtime entry is cacheable");

  const assetPath = firstHtml.match(/\bsrc="(\/_ai-runtime\/assets\/[^"]+)"/)?.[1];
  assert(assetPath, "Runtime bootstrap module was not found");
  const asset = await fetch(`${baseUrl}${assetPath}`);
  assert(asset.ok, "Runtime bootstrap module is unavailable");
  assert(asset.headers.get("access-control-allow-origin") === "*", "Runtime asset lacks CORS");
  assert(
    asset.headers.get("cross-origin-resource-policy") === "cross-origin",
    "Runtime asset lacks cross-origin resource policy"
  );
  assert(
    (asset.headers.get("cache-control") ?? "").includes("immutable"),
    "Runtime asset is not immutable"
  );
}

async function login(page) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const form = page.locator("form.auth-form");
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(password);
  await form.locator(".auth-submit").click();
  await page.waitForURL(/\/projects(?:[/?#]|$)/, { timeout: 30_000 });
}

async function verifyBrowserBoundary(projectId, provider) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 960 },
    locale: "en-US"
  });
  const page = await context.newPage();
  const browserErrors = [];
  const compilerRuntimeRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("typst.worker-") ||
      url.includes("wasm-pack-shim-") ||
      url.includes("typst_ts_web_compiler_bg.wasm")
    ) {
      compilerRuntimeRequests.push(url);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      const expectedAccessProbe =
        (message.text().includes("401 (Unauthorized)") &&
          location.url.endsWith("/v1/auth/me")) ||
        (message.text().includes("403 (Forbidden)") &&
          location.url.endsWith("/v1/admin/settings/auth"));
      if (expectedAccessProbe) return;
      browserErrors.push(`console: ${message.text()} (${location.url || "unknown URL"})`);
    }
  });

  try {
    await login(page);
    await page.goto(`${baseUrl}/project/${projectId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30_000 });
    await page.locator(".panel-editor .ui-badge-success").waitFor({ timeout: 15_000 });
    const assistantToggle = page.locator('[data-panel-toggle="feature:ai_assistant"]');
    const settingsToggle = page.locator('[data-panel-toggle="settings"]');
    await assistantToggle.click();
    await page.locator('[data-action="open-assistant-settings"]').click();
    const connectionForm = page.locator(".ai-connection-form");
    await connectionForm.waitFor({ timeout: 15_000 });
    await connectionForm.locator('[name="connection-name"]').fill(
      provider.kind === "mock" ? "Browser mock" : "External provider smoke"
    );
    await connectionForm.locator('[name="connection-protocol"]').selectOption(provider.protocol);
    await connectionForm.locator('[name="connection-endpoint"]').fill(provider.baseUrl);
    await connectionForm.locator('[name="connection-model"]').fill(provider.model);
    if (provider.kind === "mock") {
      await connectionForm.locator('[name="connection-reasoning"]').check();
      await connectionForm.locator('[name="connection-request-overrides"]').fill(JSON.stringify({
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_budget: 8_192
        },
        nvext: { max_thinking_tokens: 4_096 },
        reasoning: { effort: "high", summary: "auto" }
      }, null, 2));
    }
    await connectionForm.locator('[data-action="save-connection"]').click();
    await assistantToggle.click();
    await page.locator('.ai-live-status[data-status="configuring"]').waitFor({ timeout: 15_000 });

    const frameElement = page.locator("iframe.ai-runtime-frame");
    assert((await frameElement.getAttribute("sandbox")) === "allow-scripts", "iframe sandbox widened");
    const runtimeFrame = page.frames().find((frame) =>
      frame.url().includes("/_ai-runtime/bootstrap.html")
    );
    assert(runtimeFrame, "Runtime iframe was not attached");

    const hostCannotReadRuntime = await page.evaluate(() => {
      const frame = document.querySelector("iframe.ai-runtime-frame");
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) return false;
      try {
        void frame.contentWindow.document.body;
        return false;
      } catch (error) {
        return error instanceof DOMException && error.name === "SecurityError";
      }
    });
    assert(hostCannotReadRuntime, "host script can read the opaque Runtime document");

    const runtimeIsolation = await runtimeFrame.evaluate(async () => {
      const denied = (operation) => {
        try {
          operation();
          return false;
        } catch (error) {
          return error instanceof DOMException && error.name === "SecurityError";
        }
      };
      const parentDomDenied = denied(() => void window.parent.document.body);
      const localStorageDenied = denied(() => window.localStorage.getItem("runtime-probe"));
      const indexedDbDenied = denied(() => window.indexedDB.open("runtime-probe"));
      let cookie = "unreadable";
      try {
        cookie = document.cookie;
      } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") cookie = "";
      }
      let serviceWorkerUnavailable = !("serviceWorker" in navigator);
      if (!serviceWorkerUnavailable) {
        try {
          serviceWorkerUnavailable = (await navigator.serviceWorker.getRegistrations()).length === 0;
        } catch (error) {
          serviceWorkerUnavailable = error instanceof DOMException && error.name === "SecurityError";
        }
      }
      return {
        parentDomDenied,
        localStorageDenied,
        indexedDbDenied,
        cookieEmpty: cookie === "",
        serviceWorkerUnavailable
      };
    });
    assert(runtimeIsolation.parentDomDenied, "Runtime can read the host DOM");
    assert(runtimeIsolation.localStorageDenied, "Runtime can use Local Storage");
    assert(runtimeIsolation.indexedDbDenied, "Runtime can use IndexedDB");
    assert(runtimeIsolation.cookieEmpty, "Runtime can read application cookies");
    assert(runtimeIsolation.serviceWorkerUnavailable, "Runtime can use an application service worker");

    await runtimeFrame.locator('input[name="credential"]').fill(provider.credential);
    await runtimeFrame.locator('[data-action="activate-connection"]').click();
    try {
      await page.locator('.ai-live-status[data-status="ready"]').waitFor({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        `Runtime activation failed: ${JSON.stringify({
          hostStatus: await page.locator(".ai-live-status").textContent(),
          hostError: await page.locator(".ai-runtime-error").textContent().catch(() => null),
          runtimeSurface: await runtimeFrame.evaluate(() => document.body.innerText),
          browserErrors
        })}`,
        { cause: error }
      );
    }
    const credentialStorageLeaks = await page.evaluate(async (secret) => {
      const localStorageLeak = Object.keys(window.localStorage).some((key) =>
        (window.localStorage.getItem(key) ?? "").includes(secret)
      );
      const sessionStorageLeak = Object.keys(window.sessionStorage).some((key) =>
        (window.sessionStorage.getItem(key) ?? "").includes(secret)
      );
      const indexedDbValues = [];
      for (const databaseInfo of await window.indexedDB.databases()) {
        if (!databaseInfo.name) continue;
        const values = await new Promise((resolve, reject) => {
          const request = window.indexedDB.open(databaseInfo.name);
          request.addEventListener("error", () => reject(request.error), { once: true });
          request.addEventListener("success", () => {
            const database = request.result;
            const storeNames = [...database.objectStoreNames];
            if (storeNames.length === 0) {
              database.close();
              resolve([]);
              return;
            }
            const transaction = database.transaction(storeNames, "readonly");
            const collected = [];
            transaction.addEventListener("complete", () => {
              database.close();
              resolve(collected);
            }, { once: true });
            transaction.addEventListener("error", () => reject(transaction.error), { once: true });
            for (const storeName of storeNames) {
              const getAll = transaction.objectStore(storeName).getAll();
              getAll.addEventListener("success", () => collected.push(...getAll.result), {
                once: true
              });
            }
          }, { once: true });
        });
        indexedDbValues.push(...values);
      }
      return {
        localStorageLeak,
        sessionStorageLeak,
        indexedDbLeak: JSON.stringify(indexedDbValues).includes(secret)
      };
    }, provider.credential);
    assert(
      !credentialStorageLeaks.localStorageLeak &&
        !credentialStorageLeaks.sessionStorageLeak &&
        !credentialStorageLeaks.indexedDbLeak,
      "Runtime credential leaked into host browser storage"
    );

    const contextMarker = `TOSS_CONTEXT_${runId}`;
    const responseTimeout = provider.kind === "external" ? 120_000 : 30_000;
    const assistantMessages = page.locator('.ai-message--assistant[data-state="complete"]');
    const waitForAssistantTurn = async (index, label) => {
      const message = assistantMessages.nth(index);
      try {
        await message.waitFor({ timeout: responseTimeout });
      } catch (error) {
        const diagnostics = await page.evaluate(() => ({
          status: document.querySelector(".ai-live-status")?.textContent,
          error: document.querySelector(".ai-runtime-error")?.textContent,
          transcript: document.querySelector(".ai-transcript")?.textContent,
          runtimeText: document.querySelector("iframe.ai-runtime-frame")?.getAttribute("src")
        }));
        diagnostics.runtimeSurface = await runtimeFrame.evaluate(() => document.body.innerText);
        throw new Error(
          `${label} timed out: ${JSON.stringify({ diagnostics, browserErrors })}`,
          { cause: error }
        );
      }
      return message;
    };
    const waitForAssistant = async (index, label) => {
      const message = await waitForAssistantTurn(index, label);
      const text = (await message.locator(".ai-markdown").textContent())?.trim() ?? "";
      assert(text && text !== "Failed", `${label} completed without assistant text`);
      return text;
    };

    const firstPrompt = provider.kind === "mock"
      ? "Read main.typ and verify that its source is available."
      : `Remember this exact token for my next message: ${contextMarker}. Reply only READY.`;
    await page.locator('.ai-composer [name="prompt"]').fill(firstPrompt);
    await page.locator('[data-action="send-prompt"]').click();
    if (provider.kind === "mock") {
      await page.locator('.ai-turn-activity[data-activity="thinking"]').waitFor({
        timeout: responseTimeout
      });
      const acceptReview = page.getByTestId("ai-review-accept");
      try {
        await acceptReview.waitFor({ timeout: responseTimeout });
      } catch (error) {
        throw new Error(`candidate review did not open: ${JSON.stringify({
          hostStatus: await page.locator(".ai-live-status").textContent(),
          hostError: await page.locator(".ai-runtime-error").textContent().catch(() => null),
          transcript: await page.locator(".ai-transcript").textContent().catch(() => null),
          requestRoles: provider.requests.map((request) =>
            request.body.messages.map((message) => message.role).join(",")
          ),
          toolResults: provider.requests.map((request) =>
            request.body.messages
              .filter((message) => message.role === "tool")
              .map((message) => message.content)
          ),
          compilerRuntimeRequests,
          browserErrors
        })}`, { cause: error });
      }
      await page.getByTestId("ai-review-compile-passed").waitFor({ timeout: responseTimeout });
      assert(
        (await page.locator(".ai-edit-review-code").textContent())?.includes("+#set document("),
        "central Editor review did not render the proposed unified diff"
      );
      const reviewHandoff = await waitForAssistantTurn(0, "review handoff");
      for (const trigger of await reviewHandoff
        .locator('.ai-activity-trigger[aria-expanded="false"]')
        .all()) {
        await trigger.click();
      }
      assert(
        await reviewHandoff.locator('.ai-tool-activity[data-state="complete"]').count() >= 3,
        "review handoff did not preserve the completed Workspace tool activity"
      );
      assert(
        !(await page.locator('.ai-message--assistant[data-state="streaming"]').isVisible()),
        "agent turn remained active after handing the proposal to Workspace review"
      );
      await acceptReview.click();
      await page.waitForFunction(() => (
        document.querySelector(".cm-content")?.textContent?.includes("title: [AI Runtime Smoke]")
      ), null, { timeout: 10_000 });
      await page.locator('.ai-live-status[data-status="ready"]').waitFor({
        timeout: responseTimeout
      });
      await page.locator('.ai-composer [name="prompt"]').fill(
        "Summarize the accepted review result."
      );
      await page.locator('[data-action="send-prompt"]').click();
      await page.locator('.ai-reasoning-part[data-state="streaming"]').waitFor({
        timeout: responseTimeout
      });
      assert(
        !(await assistantMessages.nth(1).isVisible()),
        "assistant response completed before streamed reasoning became visible"
      );
    }
    const firstResponseIndex = provider.kind === "mock" ? 1 : 0;
    const secondResponseIndex = firstResponseIndex + 1;
    await waitForAssistant(firstResponseIndex, "first pi Runtime response");
    if (provider.kind === "mock") {
      await page.locator('.ai-token-usage[data-source="provider"]').waitFor({ timeout: 5_000 });
      assert(
        await page.locator('.ai-token-usage[data-source="provider"]').isVisible(),
        "provider-reported token usage was not projected into the Assistant UI"
      );
      assert(
        provider.requests.every((request) => request.body.stream_options?.include_usage === true),
        "OpenAI-compatible requests did not ask for streamed token usage"
      );
      assert(provider.requests.every((request) => (
        request.body.chat_template_kwargs?.enable_thinking === true &&
        request.body.chat_template_kwargs?.reasoning_budget === 8_192 &&
        request.body.nvext?.max_thinking_tokens === 4_096 &&
        request.body.reasoning?.effort === "high" &&
        request.body.reasoning?.summary === "auto" &&
        !("reasoning_effort" in request.body)
      )), "the exact Provider JSON was not applied to every request");
      await page.locator(".cm-content").waitFor({ timeout: 10_000 });
      assert(
        (await page.locator(".cm-content").innerText()).includes("title: [AI Runtime Smoke]"),
        "accepted patch was not applied through the live editor document"
      );
    }

    const secondPrompt = provider.kind === "mock"
      ? "Verify retained conversation context."
      : "Reply with only the exact token I asked you to remember in my previous message.";
    await page.locator('.ai-composer [name="prompt"]').fill(secondPrompt);
    await page.locator('[data-action="send-prompt"]').click();
    const secondResponse = await waitForAssistant(secondResponseIndex, "second pi Runtime response");
    if (provider.kind === "mock") {
      assert(
        await assistantMessages.nth(secondResponseIndex).locator(".katex").count() >= 2,
        "assistant response did not render inline and display math with KaTeX"
      );
      assert(
        await assistantMessages.nth(secondResponseIndex).locator(".katex-display").count() === 1,
        "assistant response did not render exactly one display-math block"
      );
      assert(provider.requests.length === 5, "mock provider did not receive the compile/revise/review loop and second turn");
      assert(
        provider.requests.every((request) => request.origin === "null"),
        "opaque Runtime did not use the expected null CORS origin"
      );
      assert(
        provider.requests.every((request) =>
          request.authorization === `Bearer ${provider.credential}`
        ),
        "Runtime did not bind the in-memory credential to provider requests"
      );
      assert(
        provider.requests[0].body.tools.some((tool) =>
          tool.function?.name === "query_typst_docs"
        ),
        "pi provider request did not advertise the local Typst reference tool"
      );
      assert(
        provider.requests[0].body.tools.some((tool) =>
          tool.function?.name === "read_project_file"
        ),
        "pi provider request did not advertise the Workspace read tool"
      );
      assert(
        provider.requests[0].body.tools.some((tool) =>
          tool.function?.name === "apply_patch"
        ),
        "pi provider request did not advertise the reviewed patch tool"
      );
      assert(
        provider.requests[0].body.tools.some((tool) =>
          tool.function?.name === "write_file"
        ),
        "pi provider request did not advertise the reviewed full-file tool"
      );
      const systemPrompt = provider.requests[0].body.messages.find(
        (message) => message.role === "system"
      )?.content;
      const initialWorkspaceContext = workspaceContextFromPrompt(systemPrompt);
      assert(
        typeof initialWorkspaceContext.project_name === "string" &&
          initialWorkspaceContext.active_path === "main.typ" &&
          initialWorkspaceContext.compilation !== null &&
          typeof initialWorkspaceContext.compilation === "object",
        "turn-start Workspace state was not injected into the system prompt"
      );
      const collapsedActivity = page.locator('.ai-activity-trigger[aria-expanded="false"]');
      for (const trigger of await collapsedActivity.all()) await trigger.click();
      assert(
        await page.locator('.ai-tool-activity[data-state="complete"]').count() >= 3,
        "completed Workspace tools were not represented in the Agent activity UI"
      );
      assert(
        provider.requests[1].body.messages.map((message) => message.role).join(",") ===
          "system,user,assistant,tool",
        "pi Agent did not feed the Workspace result back into its tool loop"
      );
      const toolMessage = provider.requests[1].body.messages.find((message) => message.role === "tool");
      const readResult = parseJsonObject(toolMessage?.content, "Workspace read result");
      assert(
        readResult.path === "main.typ" &&
          typeof readResult.numbered_content === "string" &&
          readResult.numbered_content.startsWith("1 | "),
        "Workspace tool result did not contain line-numbered main.typ source"
      );
      assert(
        provider.requests[2].body.messages.map((message) => message.role).join(",") ===
          "system,user,assistant,tool,assistant,tool",
        "pi Agent did not resume after candidate compilation failed"
      );
      const failedPatchToolMessage = provider.requests[2].body.messages.findLast(
        (message) => message.role === "tool"
      );
      const failedPatchResult = parseJsonObject(
        failedPatchToolMessage?.content,
        "failed patch result"
      );
      assert(
        failedPatchResult.status === "compile_failed" &&
          failedPatchResult.verification?.status === "failed" &&
          failedPatchResult.verification.diagnostics?.some(
            (diagnostic) => diagnostic.severity === "error"
          ),
        "candidate compiler diagnostics did not return to the model"
      );
      assert(
        provider.requests[3].body.messages.map((message) => message.role).join(",") ===
          "system,user,assistant,tool,assistant,tool,assistant,tool,user",
        "the post-review message did not start a fresh Agent turn with retained history"
      );
      const pendingPatchToolMessage = provider.requests[3].body.messages.findLast(
        (message) => message.role === "tool"
      );
      const pendingPatchResult = parseJsonObject(
        pendingPatchToolMessage?.content,
        "pending patch result"
      );
      assert(
        pendingPatchResult.status === "review_pending" &&
          pendingPatchResult.verification?.status === "passed" &&
          typeof pendingPatchResult.review_id === "string" &&
          !("decision" in pendingPatchResult),
        "the completed edit turn did not retain its review-pending tool result"
      );
      const postReviewSystemPrompt = provider.requests[3].body.messages.find(
        (message) => message.role === "system"
      )?.content;
      const postReviewWorkspaceContext = workspaceContextFromPrompt(postReviewSystemPrompt);
      assert(
        postReviewWorkspaceContext.last_edit_review?.decision === "accepted",
        "the accepted Workspace review was not exposed in the next turn snapshot"
      );
      assert(
        provider.requests[4].body.messages.map((message) => message.role).join(",") ===
          "system,user,assistant,tool,assistant,tool,assistant,tool,user,assistant,user",
        "pi Agent did not retain the completed tool-assisted turn"
      );
    } else {
      assert(
        secondResponse.includes(contextMarker),
        "external provider response did not demonstrate retained conversation context"
      );
    }

    const conversationSelect = page.getByTestId("ai-conversation-select");
    const originalConversationId = await conversationSelect.inputValue();
    await page.getByTestId("ai-conversation-new").click();
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid="ai-conversation-select"] option').length === 2
    ));
    const isolatedConversationId = await conversationSelect.inputValue();
    assert(
      isolatedConversationId !== originalConversationId,
      "new conversation reused the previous identity"
    );
    assert(
      await page.locator(".ai-message").count() === 0,
      "new conversation inherited the previous transcript"
    );
    await page.locator('.ai-live-status[data-status="ready"]').waitFor({ timeout: 5_000 });
    if (provider.kind === "mock") {
      await page.locator('.ai-composer [name="prompt"]').fill("Start an isolated conversation.");
      await page.locator('[data-action="send-prompt"]').click();
      await waitForAssistant(0, "isolated conversation response");
      assert(
        provider.requests[5].body.messages.map((message) => message.role).join(",") ===
          "system,user",
        "new conversation inherited prior model or tool history"
      );
      assert(
        provider.requests[6].body.messages.map((message) => message.role).join(",") ===
          "system,user,assistant,tool",
        "pi Agent did not feed the Typst documentation result back into its tool loop"
      );
      const typstDocsToolMessage = provider.requests[6].body.messages.findLast(
        (message) => message.role === "tool"
      );
      const typstDocsResult = parseJsonObject(
        typstDocsToolMessage?.content,
        "Typst documentation result"
      );
      assert(
        typstDocsResult.version === "0.15.0" &&
          Array.isArray(typstDocsResult.results) &&
          typstDocsResult.results.some((result) => result.name === "math.equation"),
        `local Typst documentation query did not return its pinned search results: ${
          JSON.stringify({ content: typstDocsToolMessage?.content, browserErrors })
        }`
      );
    }
    await conversationSelect.selectOption(originalConversationId);
    await assistantMessages.nth(secondResponseIndex).waitFor({ timeout: 5_000 });
    assert(
      await conversationSelect.locator("option").count() === 2,
      "conversation switch discarded the new conversation"
    );

    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    await settingsToggle.click();
    assert(await page.locator(".workspace-optional-panel-host").isHidden(), "Assistant did not close");
    await assistantToggle.click();
    await assistantMessages.nth(secondResponseIndex).waitFor({ timeout: 5_000 });

    await runtimeFrame.evaluate(() => {
      window.location.href = `${window.location.pathname}?navigation-probe=1`;
    });
    try {
      await page.locator('.ai-runtime-error[data-error-code="runtime_navigated"]').waitFor({
        timeout: 10_000
      });
    } catch (error) {
      throw new Error(
        `Runtime navigation was not invalidated: ${JSON.stringify({
          hostStatus: await page.locator(".ai-live-status").textContent(),
          frameUrl: runtimeFrame.url()
        })}`,
        { cause: error }
      );
    }
    await page.evaluate(() => window.localStorage.setItem("toss.ui-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30_000 });
    await page.locator(".panel-editor .ui-badge-success").waitFor({ timeout: 15_000 });
    await page.locator('[data-panel-toggle="feature:ai_assistant"]').click();
    await page.locator('.ai-live-status[data-status="configuring"]').waitFor({ timeout: 15_000 });
    const restoredConversationSelect = page.getByTestId("ai-conversation-select");
    assert(
      await restoredConversationSelect.locator("option").count() === 2,
      "project conversation collection was not restored from IndexedDB"
    );
    assert(
      await page.locator('.ai-message--assistant[data-state="complete"]').count() ===
        secondResponseIndex + 1,
      "active conversation transcript was not restored after reload"
    );
    for (const trigger of await page.locator('.ai-activity-trigger[aria-expanded="false"]').all()) {
      await trigger.click();
    }
    assert(
      !(await page.locator(".ai-transcript").innerText()).includes(
        "Checking the accepted patch and current project state."
      ),
      "model reasoning was persisted in the host conversation store"
    );
    const localizedRuntimeFrame = page.frames().find((frame) =>
      frame.url().includes("/_ai-runtime/bootstrap.html")
    );
    assert(localizedRuntimeFrame, "localized Runtime iframe was not attached");
    await localizedRuntimeFrame.waitForFunction(() => document.documentElement.lang === "zh-CN", null, {
      timeout: 5_000
    });
    if (provider.kind === "mock") {
      await localizedRuntimeFrame.locator('input[name="credential"]').fill(provider.credential);
      await localizedRuntimeFrame.locator('[data-action="activate-connection"]').click();
      await page.locator('.ai-live-status[data-status="ready"]').waitFor({ timeout: 15_000 });
      await page.locator('.ai-composer [name="prompt"]').fill("Verify locale propagation.");
      await page.locator('[data-action="send-prompt"]').click();
      await page
        .getByText(/Mock provider turn 8 completed\./)
        .waitFor({ timeout: 10_000 });
    }

    assert(browserErrors.length === 0, browserErrors.join("\n"));
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  await verifyHttpBoundary();
  const project = await createFixture();
  const provider = (await externalProvider()) ?? await startMockProvider();
  try {
    await verifyBrowserBoundary(project.id, provider);
    console.log(JSON.stringify({
      ok: true,
      projectId: project.id,
      providerMode: provider.kind,
      providerRequests: provider.kind === "mock" ? provider.requests.length : 2
    }, null, 2));
  } finally {
    await provider.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
