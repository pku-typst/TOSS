import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const runId = Date.now().toString();
const email = `ai-runtime-${runId}@example.com`;
const password = "Runtime1234!";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 30_000 });
}

async function verifyBrowserBoundary(projectId) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 960 },
    locale: "en-US"
  });
  const page = await context.newPage();
  const browserErrors = [];
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
    await page.getByText("Online", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page.locator(".ai-runtime-state", { hasText: "Ready" }).waitFor({ timeout: 15_000 });

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

    await page.locator(".ai-composer textarea").fill("Verify the isolated fake provider.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    try {
      await page
        .getByText("The deterministic fake provider completed without network access.", {
          exact: false
        })
        .waitFor({ timeout: 10_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector(".ai-runtime-state")?.textContent,
        error: document.querySelector(".ai-runtime-error")?.textContent,
        transcript: document.querySelector(".ai-transcript")?.textContent,
        runtimeText: document.querySelector("iframe.ai-runtime-frame")?.getAttribute("src")
      }));
      diagnostics.runtimeSurface = await runtimeFrame.evaluate(() => document.body.innerText);
      throw new Error(
        `fake Runtime response timed out: ${JSON.stringify({ diagnostics, browserErrors })}`,
        { cause: error }
      );
    }
    await page.locator('.ai-message--assistant[data-state="complete"]').waitFor({ timeout: 10_000 });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert(await page.locator(".workspace-optional-panel-host").isHidden(), "Assistant did not close");
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page
      .getByText("The deterministic fake provider completed without network access.", {
        exact: false
      })
      .waitFor({ timeout: 5_000 });

    await runtimeFrame.evaluate(() => {
      window.location.href = `${window.location.pathname}?navigation-probe=1`;
    });
    try {
      await page.locator(".ai-runtime-state--error").waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `Runtime navigation was not invalidated: ${JSON.stringify({
          hostStatus: await page.locator(".ai-runtime-state").textContent(),
          frameUrl: runtimeFrame.url()
        })}`,
        { cause: error }
      );
    }
    await page.getByText(/runtime_navigated/).waitFor({ timeout: 10_000 });

    await page.evaluate(() => window.localStorage.setItem("toss.ui-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30_000 });
    await page.getByText("在线", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "助手", exact: true }).click();
    await page.locator(".ai-runtime-state", { hasText: "就绪" }).waitFor({ timeout: 15_000 });
    const localizedRuntimeFrame = page.frames().find((frame) =>
      frame.url().includes("/_ai-runtime/bootstrap.html")
    );
    assert(localizedRuntimeFrame, "localized Runtime iframe was not attached");
    await localizedRuntimeFrame
      .getByText("隔离的浏览器 Runtime", { exact: true })
      .waitFor({ timeout: 5_000 });
    await page.locator(".ai-composer textarea").fill("验证中文 Runtime 文案。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page
      .getByText("确定性模拟 Provider 已在不访问网络的情况下完成响应。", {
        exact: false
      })
      .waitFor({ timeout: 10_000 });

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
  await verifyBrowserBoundary(project.id);
  console.log(JSON.stringify({ ok: true, projectId: project.id }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
