import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-full-load";
const runId = Date.now().toString();
const ownerEmail = `full-load-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const assetCount = Number.parseInt(process.env.FULL_LOAD_ASSET_COUNT || "35", 10);
const assetBytes = Number.parseInt(process.env.FULL_LOAD_ASSET_BYTES || String(2 * 1024 * 1024), 10);
const chapterCount = Number.parseInt(process.env.FULL_LOAD_CHAPTER_COUNT || "5", 10);

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
      authorization: `Bearer ${token}`,
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
  const username = email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
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
    sessionToken: payload.session_token
  };
}

function buildLargeSvg(targetBytes, color) {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${color}"/><desc>`;
  const tail = "</desc></svg>";
  const payloadBytes = Math.max(0, targetBytes - head.length - tail.length);
  return `${head}${"x".repeat(payloadBytes)}${tail}`;
}

async function loginUi(page, email, password) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await page.getByRole("heading", { name: /Projects|项目/ }).waitFor({ timeout: 60000 });
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".panel-editor .panel-header").first().waitFor({ timeout: 60000 });
}

function parseProgressTotal(text) {
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    loaded: Number.parseInt(match[1], 10),
    total: Number.parseInt(match[2], 10)
  };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Full Load Owner");
  const project = await bearerApi("POST", "/v1/projects", owner.sessionToken, {
    name: `Full load ${runId}`
  });
  const projectId = project.id;

  const sectionPaths = [];
  const chapterSections = Array.from({ length: chapterCount }, () => []);
  for (let index = 0; index < assetCount; index += 1) {
    const chapterIndex = index % chapterCount;
    const sectionPath = `sections/sec-${String(index).padStart(3, "0")}.typ`;
    const assetPath = `figures/ch-${String(chapterIndex).padStart(2, "0")}/img-${String(index).padStart(3, "0")}.svg`;
    sectionPaths.push(sectionPath);
    chapterSections[chapterIndex].push({ sectionPath, assetPath });
    const color = `#${((index * 811) % 0xffffff).toString(16).padStart(6, "0")}`;
    const svg = buildLargeSvg(assetBytes, color);
    await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
      path: assetPath,
      content_base64: Buffer.from(svg, "utf8").toString("base64"),
      content_type: "image/svg+xml"
    });
    if ((index + 1) % 5 === 0 || index + 1 === assetCount) {
      // eslint-disable-next-line no-console
      console.log(`uploaded ${index + 1}/${assetCount}`);
    }
  }

  let documentCount = 0;
  for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
    const entries = chapterSections[chapterIndex];
    for (const entry of entries) {
      const content = [`= Section ${entry.sectionPath}`, `#image("../${entry.assetPath}", width: 45pt)`].join("\n");
      await bearerApi(
        "PUT",
        `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(entry.sectionPath)}`,
        owner.sessionToken,
        { content }
      );
      documentCount += 1;
    }
    const chapterPath = `chapters/ch-${String(chapterIndex).padStart(2, "0")}.typ`;
    const chapterContent = [
      `= Chapter ${chapterIndex}`,
      ...entries.map((entry) => `#include "../${entry.sectionPath}"`)
    ].join("\n");
    await bearerApi(
      "PUT",
      `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent(chapterPath)}`,
      owner.sessionToken,
      { content: chapterContent }
    );
    documentCount += 1;
  }

  const mainContent = [
    "= Full Project Load Regression",
    ...Array.from({ length: chapterCount }, (_, chapterIndex) => {
      const chapterPath = `chapters/ch-${String(chapterIndex).padStart(2, "0")}.typ`;
      return `#include "${chapterPath}"`;
    })
  ].join("\n");
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    owner.sessionToken,
    { content: mainContent }
  );
  documentCount += 1;
  await bearerApi("PATCH", `/v1/projects/${projectId}/settings/entry-file`, owner.sessionToken, {
    entry_file_path: "main.typ"
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1700, height: 980 } });
  const page = await context.newPage();
  try {
    await loginUi(page, owner.email, owner.password);
    await openWorkspace(page, projectId);

    const expectedTotal = documentCount + assetCount;
    let seenProgressTotal = null;
    let seenProgressLoaded = 0;
    let lastError = "";
    let hasPreview = false;

    const start = Date.now();
    while (Date.now() - start < 360000) {
      const state = await page.evaluate(() => {
        const statuses = Array.from(document.querySelectorAll(".preview-runtime-status")).map((node) =>
          (node.textContent || "").trim()
        );
        const errorText = (document.querySelector(".panel-inline-error")?.textContent || "").trim();
        const hasPreviewCanvas = document.querySelector(".pdf-frame canvas, .pdf-frame .typst-page") !== null;
        return { statuses, errorText, hasPreviewCanvas };
      });
      if (state.errorText) lastError = state.errorText;
      const bogus =
        /outside of project root|failed to load file \(access denied\)|cannot read file outside/i.test(
          state.errorText
        );
      if (bogus) {
        throw new Error(`Saw bogus compile error during initial load: ${state.errorText}`);
      }
      for (const line of state.statuses) {
        const parsed = parseProgressTotal(line);
        if (!parsed) continue;
        seenProgressTotal = parsed.total;
        seenProgressLoaded = Math.max(seenProgressLoaded, parsed.loaded);
      }
      if (state.hasPreviewCanvas && !state.errorText) {
        hasPreview = true;
        break;
      }
      await wait(350);
    }

    if (!hasPreview) {
      throw new Error(`Preview did not become ready. Last error: ${lastError || "none"}`);
    }
    if (seenProgressTotal !== null && seenProgressTotal !== expectedTotal) {
      throw new Error(
        `Progress total mismatch. expected=${expectedTotal}, seen=${seenProgressTotal}, loaded=${seenProgressLoaded}`
      );
    }

    const screenshot = path.join(outDir, "full-project-load.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          projectId,
          assetCount,
          assetBytes,
          totalAssetBytes: assetCount * assetBytes,
          documentCount,
          expectedTotal,
          seenProgressTotal,
          seenProgressLoaded,
          screenshot
        },
        null,
        2
      )
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
