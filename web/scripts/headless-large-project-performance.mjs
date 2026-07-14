import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const screenshotDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-headless-perf";
const runId = Date.now().toString();
const userEmail = `perf-${runId}@example.com`;
const userPassword = "Perf12345!";
const username = `perf${runId}`.slice(0, 24);
const displayName = "Performance Tester";
const ASSET_COUNT = Number.parseInt(process.env.PERF_ASSET_COUNT ?? "48", 10);
const ASSET_SIZE_BYTES = Number.parseInt(process.env.PERF_ASSET_SIZE_BYTES ?? String(1_500_000), 10);
const TOTAL_MB = ((ASSET_COUNT * ASSET_SIZE_BYTES) / (1024 * 1024)).toFixed(1);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function request(method, route, token, body) {
  const contentEpochHeader = await projectContentEpochHeader(coreApi, method, route, token);
  const res = await fetch(`${coreApi}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...contentEpochHeader
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res).catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${route} failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function registerOrLogin() {
  const registerRes = await fetch(`${coreApi}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: userEmail,
      password: userPassword,
      username,
      display_name: displayName
    })
  });
  if (registerRes.ok) return parseJson(registerRes);
  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: userEmail, password: userPassword })
  });
  if (!loginRes.ok) {
    const payload = await parseJson(loginRes).catch(() => null);
    throw new Error(`login failed (${loginRes.status}): ${JSON.stringify(payload)}`);
  }
  return parseJson(loginRes);
}

function makeBytes(length, seed) {
  const bytes = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (seed + i * 31) % 251;
  }
  return bytes;
}

async function ensureLargeProject(sessionToken) {
  const project = await request("POST", "/v1/projects", sessionToken, {
    name: `Perf Large ${runId}`
  });
  const projectId = project.id;
  const coverPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7M6hkAAAAASUVORK5CYII=",
    "base64"
  );
  await request("POST", `/v1/projects/${projectId}/assets`, sessionToken, {
    path: "cover.png",
    content_base64: coverPng.toString("base64"),
    content_type: "image/png"
  });
  await request("PUT", `/v1/projects/${projectId}/documents/by-path/main.typ`, sessionToken, {
    content: `= Large project performance test\n#image("cover.png", width: 2cm)\nGenerated at ${new Date().toISOString()}`
  });
  for (let i = 0; i < ASSET_COUNT; i += 1) {
    const bytes = makeBytes(ASSET_SIZE_BYTES, i + 17);
    const fileName = `blob-${String(i).padStart(3, "0")}.bin`;
    await request("POST", `/v1/projects/${projectId}/assets`, sessionToken, {
      path: fileName,
      content_base64: bytes.toString("base64"),
      content_type: "application/octet-stream"
    });
    if ((i + 1) % 8 === 0) {
      process.stdout.write(`uploaded ${i + 1}/${ASSET_COUNT}\n`);
    }
  }
  return { projectId };
}

async function loginUi(page) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByPlaceholder("Email").fill(userEmail);
  await page.getByPlaceholder("Password").fill(userPassword);
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await page.getByRole("heading", { name: /Projects|项目/ }).waitFor({ timeout: 60000 });
}

function createMetricCollector(page, cdp) {
  const summary = {
    totalResponses: 0,
    totalEncodedBytes: 0,
    projectAssetJsonRequests: 0,
    projectAssetRawRequests: 0,
    projectAssetRawBytes: 0,
    projectAssetJsonBytes: 0
  };
  const requestUrls = new Map();
  const requestKinds = new Map();
  const onResponseReceived = (event) => {
    const url = event.response?.url || "";
    if (!url) return;
    requestUrls.set(event.requestId, url);
    summary.totalResponses += 1;
    if (/\/v1\/projects\/[^/]+\/assets\/[^/]+\/raw(?:\?|$)/.test(url)) {
      summary.projectAssetRawRequests += 1;
      requestKinds.set(event.requestId, "asset_raw");
      return;
    }
    if (/\/v1\/projects\/[^/]+\/assets\/[^/?]+(?:\?|$)/.test(url)) {
      summary.projectAssetJsonRequests += 1;
      requestKinds.set(event.requestId, "asset_json");
      return;
    }
    requestKinds.set(event.requestId, "other");
  };
  const onLoadingFinished = (event) => {
    const bytes = Number(event.encodedDataLength || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    summary.totalEncodedBytes += bytes;
    const kind = requestKinds.get(event.requestId);
    if (kind === "asset_raw") {
      summary.projectAssetRawBytes += bytes;
    } else if (kind === "asset_json") {
      summary.projectAssetJsonBytes += bytes;
    }
  };
  cdp.on("Network.responseReceived", onResponseReceived);
  cdp.on("Network.loadingFinished", onLoadingFinished);
  return {
    summary,
    dispose: () => {
      cdp.off("Network.responseReceived", onResponseReceived);
      cdp.off("Network.loadingFinished", onLoadingFinished);
    }
  };
}

async function openWorkspaceAndWait(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.locator(".panel-editor .panel-header").first().waitFor({ timeout: 120000 });
  await page.locator(".tree-label", { hasText: "main.typ" }).first().waitFor({ timeout: 120000 });
  await wait(3000);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function screenshot(page, fileName) {
  const fullPath = path.join(screenshotDir, fileName);
  await page.screenshot({ path: fullPath, fullPage: true });
  return fullPath;
}

async function run() {
  await ensureDir(screenshotDir);
  console.log(`Preparing project with ${ASSET_COUNT} assets x ${ASSET_SIZE_BYTES} bytes (~${TOTAL_MB} MB total)`);
  const auth = await registerOrLogin();
  const sessionToken = auth.session_token;
  if (!sessionToken) throw new Error("missing session token");
  const { projectId } = await ensureLargeProject(sessionToken);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 120,
    downloadThroughput: 1_000_000,
    uploadThroughput: 1_000_000
  });

  try {
    await loginUi(page);

    const initialCollector = createMetricCollector(page, cdp);
    const t0 = Date.now();
    await openWorkspaceAndWait(page, projectId);
    await wait(2000);
    const firstLoadMs = Date.now() - t0;
    initialCollector.dispose();
    const firstShot = await screenshot(page, "perf-first-load.png");

    const reloadCollector = createMetricCollector(page, cdp);
    const t1 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
    await page.locator(".panel-editor .panel-header").first().waitFor({ timeout: 120000 });
    await wait(2000);
    const secondLoadMs = Date.now() - t1;
    reloadCollector.dispose();
    const secondShot = await screenshot(page, "perf-second-load.png");

    const report = {
      runId,
      projectId,
      configuredTotalAssetMB: TOTAL_MB,
      firstLoadMs,
      secondLoadMs,
      firstLoadNetwork: initialCollector.summary,
      secondLoadNetwork: reloadCollector.summary,
      screenshots: [firstShot, secondShot]
    };

    await fs.writeFile(
      path.join(screenshotDir, `perf-report-${runId}.json`),
      JSON.stringify(report, null, 2),
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));

    if (report.secondLoadNetwork.projectAssetRawRequests > 0) {
      throw new Error(
        `Expected zero raw asset downloads on reload, got ${report.secondLoadNetwork.projectAssetRawRequests}`
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
