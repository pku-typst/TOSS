import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-revision-panel";
const runId = Date.now().toString();
const ownerEmail = `rev-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function api(method, route, token, body) {
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
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function registerOrLogin(email, password, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const registerRes = await fetch(`${coreApi}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName
    })
  });
  if (registerRes.ok) {
    return parseJson(registerRes);
  }
  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const login = await parseJson(loginRes);
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(login)}`);
  return login;
}

async function login(page, email, password) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor({ timeout: 30000 });
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const auth = await registerOrLogin(ownerEmail, ownerPassword, "Revision Owner");
  const token = auth.session_token;
  const project = await api("POST", "/v1/projects", token, { name: `Revision Panel ${runId}` });
  const projectId = project.id;
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    token,
    { content: "= Revision Panel\n\nVersion A\n" }
  );
  await api("POST", `/v1/projects/${projectId}/revisions`, token, { summary: "A" });
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    token,
    { content: "= Revision Panel\n\nVersion B\n" }
  );
  await api("POST", `/v1/projects/${projectId}/revisions`, token, { summary: "B" });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 980 },
    locale: "en-US"
  });
  const page = await context.newPage();
  const artifacts = [];

  try {
    await login(page, ownerEmail, ownerPassword);
    await page.goto(`${baseUrl}/project/${projectId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
    const liveShot = path.join(outDir, "01-live.png");
    await page.screenshot({ path: liveShot, fullPage: true });
    artifacts.push(liveShot);

    await page.getByRole("button", { name: "Revisions", exact: true }).click();
    await page.locator(".history-item").first().waitFor({ timeout: 10000 });
    await page.locator(".history-item").nth(1).click();
    await page.waitForFunction(
      () => (document.querySelector(".cm-content")?.textContent || "").includes("Version A"),
      undefined,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => !!document.querySelector(".pdf-frame canvas, .pdf-frame .typst-page"),
      undefined,
      { timeout: 15000 }
    );
    const revisionShot = path.join(outDir, "02-revision.png");
    await page.screenshot({ path: revisionShot, fullPage: true });
    artifacts.push(revisionShot);

    await page.getByRole("button", { name: "Revisions", exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector(".cm-content")?.textContent || "").includes("Version B"),
      undefined,
      { timeout: 10000 }
    );
    await page.getByText("Online", { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForFunction(
      () => !!document.querySelector(".pdf-frame canvas, .pdf-frame .typst-page"),
      undefined,
      { timeout: 15000 }
    );
    const backShot = path.join(outDir, "03-back-live.png");
    await page.screenshot({ path: backShot, fullPage: true });
    artifacts.push(backShot);

    console.log(JSON.stringify({ ok: true, projectId, screenshots: artifacts }, null, 2));
  } catch (error) {
    const fail = path.join(outDir, "99-failure.png");
    await page.screenshot({ path: fail, fullPage: true }).catch(() => undefined);
    artifacts.push(fail);
    console.error(JSON.stringify({ ok: false, error: String(error), screenshots: artifacts }, null, 2));
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main();
