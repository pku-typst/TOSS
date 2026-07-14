import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-sync-cache";
const runId = Date.now().toString();
const ownerEmail = `sync-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collabEmail = `sync-collab-${runId}@example.com`;
const collabPassword = "Collab1234!";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function bearerApi(method, route, token, body) {
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
    throw new Error(`${method} ${route} failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function registerOrLogin(email, password, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const registerRes = await fetch(`${coreApi}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, username, display_name: displayName })
  });
  if (registerRes.ok) {
    const payload = await parseJson(registerRes);
    return {
      email,
      password,
      userId: payload.user_id,
      sessionToken: payload.session_token
    };
  }
  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await parseJson(loginRes);
  if (!loginRes.ok) throw new Error(`login ${email} failed: ${loginRes.status}`);
  return {
    email,
    password,
    userId: payload.user_id,
    sessionToken: payload.session_token
  };
}

async function loginUi(page, email, password) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: /Projects|项目/ }).waitFor({ timeout: 60000 });
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".panel-editor .panel-header").first().waitFor({ timeout: 60000 });
  await page.locator(".tree-label", { hasText: "main.typ" }).first().waitFor({ timeout: 60000 });
}

async function waitForTreeContains(page, fileName, shouldExist, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await page.locator(".tree-label").filter({ hasText: fileName }).count();
    if ((count > 0) === shouldExist) return;
    await wait(250);
  }
  throw new Error(`tree expectation failed for ${fileName}: shouldExist=${shouldExist}`);
}

async function waitForEditorText(page, needle, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await page.evaluate(
      () => document.querySelector(".cm-content")?.textContent || ""
    );
    if (text.includes(needle)) return;
    await wait(250);
  }
  throw new Error(`editor did not contain "${needle}" in ${timeoutMs}ms`);
}

async function selectFile(page, fileName) {
  await page.locator(".tree-label", { hasText: fileName }).first().click({ timeout: 20000 });
  await wait(700);
}

async function captureImagePreviewHash(page) {
  return page.evaluate(() => {
    const img = document.querySelector(".file-preview-image");
    if (!(img instanceof HTMLImageElement)) return "";
    const value = img.src;
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return `${value.length}:${hash}`;
  });
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Sync Owner");
  const collaborator = await registerOrLogin(collabEmail, collabPassword, "Sync Collaborator");

  const project = await bearerApi("POST", "/v1/projects", owner.sessionToken, {
    name: `Sync cache ${runId}`
  });
  const projectId = project.id;
  await bearerApi("POST", `/v1/projects/${projectId}/roles`, owner.sessionToken, {
    user_id: collaborator.userId,
    role: "ReadWrite"
  });
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    owner.sessionToken,
    { content: "= Sync cache baseline\n" }
  );
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("ghost.typ")}`,
    owner.sessionToken,
    { content: "= Ghost\n" }
  );
  const svgA = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#2e8b57"/></svg>`;
  const svgB = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#d64545"/></svg>`;
  await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
    path: "shape.svg",
    content_base64: Buffer.from(svgA, "utf8").toString("base64"),
    content_type: "image/svg+xml"
  });

  const browser = await chromium.launch({ headless: true });
  const ownerCtx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const collabCtx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const ownerPage = await ownerCtx.newPage();
  const collabPage = await collabCtx.newPage();

  try {
    await loginUi(ownerPage, owner.email, owner.password);
    await loginUi(collabPage, collaborator.email, collaborator.password);
    await openWorkspace(ownerPage, projectId);
    await openWorkspace(collabPage, projectId);

    await waitForTreeContains(collabPage, "ghost.typ", true);
    await bearerApi("DELETE", `/v1/projects/${projectId}/files/${encodeURIComponent("ghost.typ")}`, owner.sessionToken);
    await waitForTreeContains(collabPage, "ghost.typ", false, 25000);

    const marker = `REMOTE_SYNC_${runId}`;
    await bearerApi(
      "PUT",
      `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
      owner.sessionToken,
      { content: `= Sync cache baseline\n${marker}\n` }
    );
    await waitForEditorText(collabPage, marker, 25000);

    await selectFile(collabPage, "shape.svg");
    const hashBefore = await captureImagePreviewHash(collabPage);
    if (!hashBefore) throw new Error("shape.svg preview was not rendered before update");

    await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
      path: "shape.svg",
      content_base64: Buffer.from(svgB, "utf8").toString("base64"),
      content_type: "image/svg+xml"
    });
    await selectFile(collabPage, "main.typ");
    await wait(6200);
    await selectFile(collabPage, "shape.svg");
    const hashAfter = await captureImagePreviewHash(collabPage);
    if (!hashAfter || hashAfter === hashBefore) {
      throw new Error("shape.svg cache did not refresh after remote update");
    }

    const shot = path.join(outDir, "sync-cache-regression.png");
    await collabPage.screenshot({ path: shot, fullPage: true });
    console.log(
      JSON.stringify(
        {
          ok: true,
          projectId,
          marker,
          screenshot: shot
        },
        null,
        2
      )
    );
  } finally {
    await ownerCtx.close();
    await collabCtx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
