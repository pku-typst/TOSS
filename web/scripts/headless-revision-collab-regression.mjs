import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-revision-collab";
const runId = Date.now().toString();
const ownerEmail = `rev-sync-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const marker = `REV_SYNC_${runId}`;

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
  if (!res.ok) {
    throw new Error(`${method} ${route} failed: ${res.status} ${JSON.stringify(payload)}`);
  }
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
  if (registerRes.ok) return parseJson(registerRes);
  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await parseJson(loginRes);
  if (!loginRes.ok) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function login(page, email, password) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const projectsHeading = page.getByRole("heading", { name: "Projects", exact: true });
  const emailInput = page.getByPlaceholder("Email", { exact: true });
  await emailInput.fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await projectsHeading.waitFor({ timeout: 30000 });
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".cm-content").first().waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => !!document.querySelector(".pdf-frame canvas, .pdf-frame .typst-page"),
    undefined,
    { timeout: 30000 }
  );
}

async function markerCount(page, value) {
  return page.evaluate((needle) => {
    const text = document.querySelector(".cm-content")?.textContent || "";
    return text.split(needle).length - 1;
  }, value);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const auth = await registerOrLogin(ownerEmail, ownerPassword, "Regression Owner");
  const token = auth.session_token;
  const project = await api("POST", "/v1/projects", token, { name: `Revision Sync ${runId}` });
  const projectId = project.id;
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    token,
    { content: "= Base\n\nHello\n" }
  );
  await api("POST", `/v1/projects/${projectId}/revisions`, token, { summary: "Base" });

  const browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext({
    viewport: { width: 1600, height: 980 },
    locale: "en-US"
  });
  const contextB = await browser.newContext({
    viewport: { width: 1600, height: 980 },
    locale: "en-US"
  });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const artifacts = [];

  try {
    await login(pageA, ownerEmail, ownerPassword);
    await openWorkspace(pageA, projectId);
    await pageA.locator(".cm-content").first().click();
    await pageA.keyboard.press("Control+End").catch(async () => {
      await pageA.keyboard.press("Meta+ArrowDown");
    });
    await pageA.keyboard.type(`\n${marker}\n`);
    await pageA.waitForTimeout(1600);

    let count = await markerCount(pageA, marker);
    if (count !== 1) {
      throw new Error(`expected one marker after typing; got ${count}`);
    }

    await pageA.getByRole("button", { name: "Revisions", exact: true }).click();
    await pageA.locator(".history-item").first().waitFor({ timeout: 10000 });
    await pageA.locator(".history-item").first().click();
    await pageA.waitForFunction(
      (needle) => !(document.querySelector(".cm-content")?.textContent || "").includes(needle),
      marker,
      { timeout: 15000 }
    );
    const revisionShot = path.join(outDir, "01-in-revision.png");
    await pageA.screenshot({ path: revisionShot, fullPage: true });
    artifacts.push(revisionShot);

    await pageA.getByRole("button", { name: "Revisions", exact: true }).click();
    await pageA.waitForFunction(
      (needle) => (document.querySelector(".cm-content")?.textContent || "").includes(needle),
      marker,
      { timeout: 15000 }
    );
    await pageA.waitForTimeout(900);
    count = await markerCount(pageA, marker);
    if (count !== 1) {
      throw new Error(`marker duplicated after revision toggle; got ${count}`);
    }

    await login(pageB, ownerEmail, ownerPassword);
    await openWorkspace(pageB, projectId);
    await pageB.waitForTimeout(1200);
    await pageA.waitForTimeout(1200);

    const countA = await markerCount(pageA, marker);
    const countB = await markerCount(pageB, marker);
    if (countA !== 1 || countB !== 1) {
      throw new Error(`marker mismatch after collaborator join (A=${countA}, B=${countB})`);
    }

    const finalA = path.join(outDir, "02-final-a.png");
    const finalB = path.join(outDir, "03-final-b.png");
    await pageA.screenshot({ path: finalA, fullPage: true });
    await pageB.screenshot({ path: finalB, fullPage: true });
    artifacts.push(finalA, finalB);

    console.log(
      JSON.stringify(
        {
          ok: true,
          projectId,
          marker,
          screenshots: artifacts
        },
        null,
        2
      )
    );
  } catch (error) {
    const failA = path.join(outDir, "98-failure-a.png");
    const failB = path.join(outDir, "99-failure-b.png");
    await pageA.screenshot({ path: failA, fullPage: true }).catch(() => undefined);
    await pageB.screenshot({ path: failB, fullPage: true }).catch(() => undefined);
    artifacts.push(failA, failB);
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(error),
          screenshots: artifacts
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await pageA.close().catch(() => undefined);
    await pageB.close().catch(() => undefined);
    await contextA.close().catch(() => undefined);
    await contextB.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main();
