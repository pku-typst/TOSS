import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-collab-git";
const runId = Date.now().toString();
const ownerEmail = `git-owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collaboratorEmail = `git-collab-${runId}@example.com`;
const collaboratorPassword = "Collab1234!";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

function countOccurrences(text, snippet) {
  if (!snippet) return 0;
  return text.split(snippet).length - 1;
}

function pushMainStrict(repo) {
  try {
    run("git push origin HEAD:main", repo);
    return;
  } catch {
    let recovered = false;
    try {
      run("git pull --rebase origin main", repo);
      recovered = true;
    } catch {
      run("git rebase --abort || true", repo);
      try {
        run("git pull --no-rebase origin main", repo);
        recovered = true;
      } catch {
        recovered = false;
      }
    }
    if (!recovered) throw new Error("strict sync recovery failed");
    run("git push origin HEAD:main", repo);
  }
}

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON (${res.status}): ${text}`);
  }
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
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${JSON.stringify(payload)}`);
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
    const payload = await parseJson(registerRes);
    return {
      email,
      password,
      userId: payload.user_id,
      sessionToken: payload.session_token
    };
  }

  if (registerRes.status !== 403 && registerRes.status !== 409) {
    const payload = await parseJson(registerRes);
    throw new Error(`register ${email} failed (${registerRes.status}): ${JSON.stringify(payload)}`);
  }

  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await parseJson(loginRes);
  if (!loginRes.ok) throw new Error(`login ${email} failed (${loginRes.status}): ${JSON.stringify(payload)}`);
  return {
    email,
    password,
    userId: payload.user_id,
    sessionToken: payload.session_token
  };
}

async function login(page, email, password) {
  await page.goto(`${baseUrl}/signin`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 30000 });
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
  await page.locator(".tree-label", { hasText: "main.typ" }).first().click();
}

async function editorText(page) {
  return page.locator(".cm-content").innerText();
}

async function waitForEditorContains(page, snippet, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await editorText(page)).includes(snippet)) return;
    await sleep(150);
  }
  throw new Error(`editor missing snippet: ${snippet}`);
}

async function waitForCollaboratorName(page, expected, timeoutMs = 10000) {
  const start = Date.now();
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  while (Date.now() - start < timeoutMs) {
    const info = await page.evaluate(() => {
      const collab = document.querySelector(".panel-status-toolbar .editor-peer-count");
      if (!collab) return { text: "", title: "" };
      return {
        text: collab.textContent || "",
        title: collab.getAttribute("title") || ""
      };
    });
    if (info.title.includes(expected) || info.text.includes(expected)) {
      if (uuidPattern.test(info.title) || uuidPattern.test(info.text)) {
        throw new Error(`collaborator status still shows UUID: ${info.title || info.text}`);
      }
      return;
    }
    await sleep(150);
  }
  throw new Error(`collaborator name did not appear in status: ${expected}`);
}

async function canvasChecksum(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".pdf-frame canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 2048) {
        sum = (sum * 131 + data[i] + data[i + 1] + data[i + 2]) >>> 0;
      }
      return sum;
    }
    const pageNode = document.querySelector(".pdf-frame .typst-page");
    if (!pageNode) return 0;
    const raw = pageNode.outerHTML;
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = (hash * 37 + raw.charCodeAt(i)) >>> 0;
    }
    return hash;
  });
}

async function waitForCanvas(page, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await page.locator(".pdf-frame canvas, .pdf-frame .typst-page").count()) > 0) return;
    await sleep(300);
  }
  throw new Error("preview page not rendered");
}

async function assertVisiblePreviewPage(page) {
  const metrics = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".pdf-frame .typst-page, .pdf-frame canvas"));
    const sizes = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const maxWidth = sizes.reduce((m, s) => Math.max(m, s.width), 0);
    const maxHeight = sizes.reduce((m, s) => Math.max(m, s.height), 0);
    const zoomText = document.querySelector(".zoom-indicator")?.textContent?.trim() || "";
    return { count: nodes.length, maxWidth, maxHeight, zoomText };
  });
  if (metrics.count < 1 || metrics.maxWidth < 120 || metrics.maxHeight < 120) {
    throw new Error(
      `Preview page looks collapsed (count=${metrics.count}, maxWidth=${metrics.maxWidth}, maxHeight=${metrics.maxHeight}, zoom=${metrics.zoomText})`
    );
  }
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const screenshots = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "typst-collab-git-"));
  const offline = path.join(tmpRoot, "offline");
  const stale = path.join(tmpRoot, "stale");

  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Git Owner");
  const collaborator = await registerOrLogin(collaboratorEmail, collaboratorPassword, "Git Collaborator");
  const project = await bearerApi("POST", "/v1/projects", owner.sessionToken, {
    name: `Git Test ${runId}`
  });
  const projectId = project.id;
  const writeShare = await bearerApi("POST", `/v1/projects/${projectId}/share-links`, owner.sessionToken, {
    permission: "write"
  });
  await bearerApi("POST", `/v1/share/${encodeURIComponent(writeShare.token)}/join`, collaborator.sessionToken);
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    owner.sessionToken,
    { content: "= Headless Collaboration\n\nInitial content.\n" }
  );

  const ownerPat = await bearerApi("POST", "/v1/profile/security/tokens", owner.sessionToken, {
    label: "headless-owner"
  });
  const repoLink = await bearerApi("GET", `/v1/git/repo-link/${projectId}`, owner.sessionToken);
  const repoUrl = repoLink.repo_url;
  const parsedRepoUrl = new URL(repoUrl);
  if (!parsedRepoUrl.username) parsedRepoUrl.username = "git";
  parsedRepoUrl.password = ownerPat.token;
  const authRepoUrl = parsedRepoUrl.toString();

  const browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "en-US"
  });
  const contextB = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "en-US"
  });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const browserErrors = [];
  for (const p of [pageA, pageB]) {
    p.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" && !text.includes("401 (Unauthorized)")) {
        browserErrors.push(`console:${text}`);
      }
    });
    p.on("pageerror", (err) => {
      browserErrors.push(`pageerror:${String(err)}`);
    });
  }

  try {
    await login(pageA, owner.email, owner.password);
    await login(pageB, collaborator.email, collaborator.password);
    await openWorkspace(pageA, projectId);
    await openWorkspace(pageB, projectId);
    await pageA.getByText("Online", { exact: true }).waitFor({ timeout: 30000 });
    await pageB.getByText("Online", { exact: true }).waitFor({ timeout: 30000 });
    await waitForCollaboratorName(pageA, "Git Collaborator", 15000);
    await waitForCanvas(pageA, 45000);
    await assertVisiblePreviewPage(pageA);
    await sleep(1200);
    const beforeChecksum = await canvasChecksum(pageA);

    await pageA.locator(".cm-content").click();
    await pageA.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await pageA.keyboard.type("Owner live edit.\n", { delay: 4 });
    await sleep(1200);
    await waitForEditorContains(pageB, "Owner live edit.");
    const ownerText = await editorText(pageA);
    const collaboratorText = await editorText(pageB);
    const occurrenceA = countOccurrences(ownerText, "Owner live edit.");
    const occurrenceB = countOccurrences(collaboratorText, "Owner live edit.");
    if (occurrenceA !== 1 || occurrenceB !== 1) {
      throw new Error(
        `realtime duplicate insertion detected (owner=${occurrenceA}, collaborator=${occurrenceB})`
      );
    }
    let updated = false;
    for (let i = 0; i < 50; i += 1) {
      const next = await canvasChecksum(pageA);
      if (next > 0 && next !== beforeChecksum) {
        updated = true;
        break;
      }
      await sleep(250);
    }
    if (!updated) {
      throw new Error("preview did not refresh after realtime edit");
    }

    const collabShot = path.join(outDir, "01-collab.png");
    await pageA.screenshot({ path: collabShot, fullPage: true });
    screenshots.push(collabShot);

    await fs.mkdir(offline, { recursive: true });
    await fs.mkdir(stale, { recursive: true });
    run(`git clone ${authRepoUrl} ${offline}`);
    run(`git clone ${authRepoUrl} ${stale}`);
    for (const repo of [offline, stale]) {
      try {
        run("git checkout -B main origin/main", repo);
      } catch {
        run("git checkout -B main", repo);
      }
      run("git config user.name 'Offline User'", repo);
      run("git config user.email 'offline@example.com'", repo);
    }

    const stamp = Date.now().toString();
    await fs.writeFile(path.join(offline, "notes.typ"), `= Offline Notes\n\nRemote update ${stamp}.\n`, "utf8");
    run("git add notes.typ", offline);
    run("git commit -m 'offline remote update'", offline);
    pushMainStrict(offline);

    await pageA.locator(".cm-content").click();
    await pageA.keyboard.press("End");
    await pageA.keyboard.type("\nServer-side collaborative update.\n", { delay: 4 });
    await sleep(1500);

    await fs.writeFile(path.join(stale, "main.typ"), "= Stale Push\n\nThis should conflict.\n", "utf8");
    run("git add main.typ", stale);
    run("git commit -m 'stale local update'", stale);
    let staleRejected = false;
    try {
      run("git push origin HEAD:main", stale);
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) {
      throw new Error("stale push unexpectedly succeeded");
    }

    const rejectedShot = path.join(outDir, "02-stale-rejected.png");
    await waitForCanvas(pageA, 20000);
    await assertVisiblePreviewPage(pageA);
    await pageA.screenshot({ path: rejectedShot, fullPage: true });
    screenshots.push(rejectedShot);

    run("git fetch origin main", stale);

    try {
      run("git rev-parse --verify HEAD~1", stale);
    } catch {
      await fs.writeFile(path.join(stale, "force-probe.txt"), `probe-${Date.now()}\n`, "utf8");
      run("git add force-probe.txt", stale);
      run("git commit -m 'force probe commit'", stale);
    }
    run("git reset --hard HEAD~1", stale);
    let forceRejected = false;
    try {
      run("git push --force origin HEAD:main", stale);
    } catch {
      forceRejected = true;
    }
    if (!forceRejected) {
      throw new Error("force push unexpectedly succeeded");
    }

    const finalShot = path.join(outDir, "03-after-recovery.png");
    await waitForCanvas(pageA, 20000);
    await assertVisiblePreviewPage(pageA);
    await pageA.screenshot({ path: finalShot, fullPage: true });
    screenshots.push(finalShot);

    console.log(
      JSON.stringify(
        {
          ok: true,
          projectId,
          screenshots,
          browserErrors
        },
        null,
        2
      )
    );
  } catch (error) {
    const failShot = path.join(outDir, "99-failure.png");
    await pageA.screenshot({ path: failShot, fullPage: true }).catch(() => undefined);
    screenshots.push(failShot);
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(error),
          screenshots,
          browserErrors
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
