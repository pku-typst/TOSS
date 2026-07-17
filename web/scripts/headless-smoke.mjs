import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-headless";
const runId = Date.now().toString();
const ownerEmail = `owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collaboratorEmail = `collab-${runId}@example.com`;
const collaboratorPassword = "Collab1234!";
const contextCreatedName = `from-context-${runId}.typ`;
const contextCreatedPath = `chapters/${contextCreatedName}`;
const contextRenamedName = `renamed-${runId}.typ`;
const contextRenamedPath = `chapters/${contextRenamedName}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fontPath = process.env.FONT_FILE_PATH ?? "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (!loginRes.ok) {
    throw new Error(`login ${email} failed (${loginRes.status}): ${JSON.stringify(payload)}`);
  }
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
  await page.getByRole("button", { name: /^(Continue|Sign in)$/ }).last().click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 30000 });
  await assertStandardPageLayout(page);
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
  await page.locator(".tree-label", { hasText: "main.typ" }).first().waitFor({ timeout: 30000 });
}

async function openSettingsStorage(page) {
  const storageTab = page.getByRole("tab", { name: "Storage" });
  await storageTab.waitFor({ timeout: 10000 });
  if ((await storageTab.getAttribute("aria-selected")) !== "true") {
    await storageTab.click();
  }
  await page.getByText("Git access").waitFor({ timeout: 10000 });
}

async function waitForActiveFile(page, filePath, timeoutMs = 10000) {
  await page.waitForFunction(
    (path) => {
      const headerTitle = document.querySelector(".panel-editor .panel-header h2");
      if (!headerTitle) return false;
      const title = headerTitle.getAttribute("title") || "";
      const text = headerTitle.textContent || "";
      return title === path || text.includes(path.split("/").filter(Boolean).pop() || path);
    },
    filePath,
    { timeout: timeoutMs }
  );
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
        sum = (sum * 31 + data[i] + data[i + 1] + data[i + 2]) >>> 0;
      }
      return sum;
    }
    const pageNode = document.querySelector(".pdf-frame .typst-page");
    if (!pageNode) return 0;
    const raw = pageNode.outerHTML;
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = (hash * 33 + raw.charCodeAt(i)) >>> 0;
    }
    return hash;
  });
}

async function waitForCanvas(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await page.locator(".pdf-frame canvas, .pdf-frame .typst-page").count()) > 0) return;
    await wait(300);
  }
  const errors = await page.locator(".error").allInnerTexts();
  throw new Error(`Preview not rendered. Errors: ${errors.join(" | ")}`);
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
    const typstCanvases = Array.from(
      document.querySelectorAll(".pdf-frame canvas[data-typst-ready='true']")
    );
    const maxBackingRatio = typstCanvases.reduce((maxRatio, canvas) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return maxRatio;
      return Math.max(maxRatio, canvas.width / rect.width, canvas.height / rect.height);
    }, 0);
    const semanticLayers = document.querySelectorAll(
      ".pdf-frame .typst-html-semantics, .pdf-frame .typst-semantic-layer"
    ).length;
    return {
      count: nodes.length,
      maxWidth,
      maxHeight,
      zoomText,
      maxBackingRatio,
      semanticLayers,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  });
  if (metrics.count < 1 || metrics.maxWidth < 120 || metrics.maxHeight < 120) {
    throw new Error(
      `Preview page looks collapsed (count=${metrics.count}, maxWidth=${metrics.maxWidth}, maxHeight=${metrics.maxHeight}, zoom=${metrics.zoomText})`
    );
  }
  if (metrics.semanticLayers > 0) {
    throw new Error(`Canvas preview rendered unused semantic layers (${metrics.semanticLayers})`);
  }
  if (metrics.maxBackingRatio > Math.max(1, metrics.devicePixelRatio) * 1.75) {
    throw new Error(
      `Canvas backing bitmap is oversized (ratio=${metrics.maxBackingRatio.toFixed(2)}, dpr=${metrics.devicePixelRatio})`
    );
  }
}

async function assertWorkspaceLayout(page) {
  const metrics = await page.evaluate(() => {
    const resolveBackground = (value) => {
      const probe = document.createElement("span");
      probe.style.position = "fixed";
      probe.style.pointerEvents = "none";
      probe.style.background = value;
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    };
    const stage = document.querySelector(".workspace-stage")?.getBoundingClientRect();
    const shell = document.querySelector(".workspace-shell")?.getBoundingClientRect();
    const app = document.querySelector(".app-shell")?.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
    const editorContent = document.querySelector(".panel-editor .panel-content");
    const previewContent = document.querySelector(".panel-preview .panel-content")?.getBoundingClientRect();
    const previewFrame = document.querySelector(".pdf-frame")?.getBoundingClientRect();
    const toggles = document.querySelectorAll(
      '.workspace-icon-toggles nve-button[aria-pressed]'
    ).length;
    const rootHeight = document.documentElement.clientHeight;
    const editor = document.querySelector(".cm-editor");
    const editorScroller = document.querySelector(".cm-scroller");
    const editorGutters = document.querySelector(".cm-gutters");
    const editorBody = document.querySelector(".cm-content");
    const syntaxColors = new Set(
      Array.from(document.querySelectorAll(".cm-line span"))
        .map((node) => getComputedStyle(node).color)
        .filter(Boolean)
    );
    const paintedButtonHosts = Array.from(document.querySelectorAll("nve-button")).filter(
      (node) => {
        const style = getComputedStyle(node);
        const background = style.backgroundColor;
        const transparent =
          background === "transparent" ||
          background === "rgba(0, 0, 0, 0)" ||
          /\/\s*0\s*\)$/.test(background);
        return (
          !transparent ||
          style.backgroundImage !== "none" ||
          parseFloat(style.borderTopWidth) > 0 ||
          parseFloat(style.paddingTop) > 0 ||
          parseFloat(style.paddingLeft) > 0
        );
      }
    );
    const topbarOutOfBounds = Array.from(
      document.querySelectorAll(".topbar nve-button, .topbar .workspace-project-menu-wrap")
    ).filter((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return rect.left < -0.5 || rect.right > document.documentElement.clientWidth + 0.5;
    });
    const accountMeta = document.querySelector(".topbar.workspace .workspace-meta");
    const accountLabel = accountMeta?.querySelector("span");
    const accountButton = accountMeta?.querySelector("nve-button");
    const workspaceButton = Array.from(
      document.querySelectorAll(".workspace-icon-toggles nve-button")
    ).find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const accountLabelRect = accountLabel?.getBoundingClientRect();
    const accountButtonRect = accountButton?.getBoundingClientRect();
    const workspaceButtonRect = workspaceButton?.getBoundingClientRect();
    const activeToggle = document.querySelector(
      '.workspace-icon-toggles nve-button[aria-pressed="true"]'
    );
    const activeToggleInternal = activeToggle?.shadowRoot?.querySelector("[internal-host]");
    const selectedTreeNode = document.querySelector(".tree-node.active");
    const activeEditorLine = document.querySelector(".cm-activeLine");
    const firstPanel = document.querySelector(".workspace-stage .panel");
    const firstPanelHeader = firstPanel?.querySelector(".panel-header");
    const workspaceShell = document.querySelector(".workspace-shell");
    return {
      stageBottomGap: stage ? Math.max(0, rootHeight - stage.bottom) : 999,
      stageTop: stage?.top ?? -1,
      stageHeight: stage?.height ?? -1,
      shellBottomGap: shell ? Math.max(0, rootHeight - shell.bottom) : 999,
      shellHeight: shell?.height ?? -1,
      appHeight: app?.height ?? -1,
      appBottomGap: app ? Math.max(0, rootHeight - app.bottom) : 999,
      topbarHeight: topbar?.height ?? -1,
      editorPadding: editorContent ? getComputedStyle(editorContent).padding : "missing",
      previewHeightDelta:
        previewContent && previewFrame ? Math.abs(previewContent.height - previewFrame.height) : 999,
      toggles,
      editorDisplay: editor ? getComputedStyle(editor).display : "missing",
      editorFont: editorScroller ? getComputedStyle(editorScroller).fontFamily : "missing",
      editorGutterDisplay: editorGutters ? getComputedStyle(editorGutters).display : "missing",
      editorWhiteSpace: editorBody ? getComputedStyle(editorBody).whiteSpace : "missing",
      syntaxColorCount: syntaxColors.size,
      paintedButtonHostCount: paintedButtonHosts.length,
      topbarOutOfBoundsCount: topbarOutOfBounds.length,
      accountFlexWrap: accountMeta ? getComputedStyle(accountMeta).flexWrap : "missing",
      accountLabelHeight: accountLabelRect?.height ?? 0,
      accountLabelButtonCenterDelta:
        accountLabelRect && accountButtonRect
          ? Math.abs(
              accountLabelRect.top + accountLabelRect.height / 2 -
                (accountButtonRect.top + accountButtonRect.height / 2)
            )
          : 999,
      accountButtonCenterDelta:
        accountButtonRect && workspaceButtonRect
          ? Math.abs(
              accountButtonRect.top + accountButtonRect.height / 2 -
                (workspaceButtonRect.top + workspaceButtonRect.height / 2)
            )
          : 999,
      brandBackground: resolveBackground("var(--toss-brand-primary)"),
      selectedBackground: resolveBackground("var(--toss-surface-selected)"),
      activeLineBackgroundToken: resolveBackground("var(--toss-brand-subtle)"),
      activeToggleBackground: activeToggleInternal
        ? getComputedStyle(activeToggleInternal).backgroundColor
        : "missing",
      selectedTreeBackground: selectedTreeNode
        ? getComputedStyle(selectedTreeNode).backgroundColor
        : "missing",
      activeEditorLineBackground: activeEditorLine
        ? getComputedStyle(activeEditorLine).backgroundColor
        : "missing",
      panelRadius: firstPanel ? parseFloat(getComputedStyle(firstPanel).borderRadius) || 0 : 999,
      panelShadow: firstPanel ? getComputedStyle(firstPanel).boxShadow : "missing",
      panelHeaderHeight: firstPanelHeader?.getBoundingClientRect().height ?? 999,
      workspacePadding: workspaceShell ? getComputedStyle(workspaceShell).padding : "missing"
    };
  });
  if (metrics.toggles < 4) throw new Error("panel icon toggles are missing");
  if (metrics.editorPadding !== "0px") throw new Error(`editor panel has unexpected padding: ${metrics.editorPadding}`);
  if (metrics.previewHeightDelta > 4) {
    throw new Error(`preview frame does not fill panel content (delta=${metrics.previewHeightDelta})`);
  }
  if (metrics.stageBottomGap > 20) {
    throw new Error(
      `workspace leaves large bottom gap (${metrics.stageBottomGap}px, stageTop=${metrics.stageTop}, stageHeight=${metrics.stageHeight}, shellHeight=${metrics.shellHeight}, shellGap=${metrics.shellBottomGap}, appHeight=${metrics.appHeight}, appGap=${metrics.appBottomGap}, topbar=${metrics.topbarHeight})`
    );
  }
  if (metrics.editorDisplay !== "flex" || metrics.editorGutterDisplay !== "flex") {
    throw new Error(
      `CodeMirror base theme is missing (editor=${metrics.editorDisplay}, gutters=${metrics.editorGutterDisplay})`
    );
  }
  if (!/mono/i.test(metrics.editorFont) || !/^(pre|break-spaces)$/.test(metrics.editorWhiteSpace)) {
    throw new Error(
      `CodeMirror typography is missing (font=${metrics.editorFont}, whiteSpace=${metrics.editorWhiteSpace})`
    );
  }
  if (metrics.syntaxColorCount < 2) {
    throw new Error(`CodeMirror syntax highlighting is missing (colors=${metrics.syntaxColorCount})`);
  }
  if (metrics.paintedButtonHostCount > 0) {
    throw new Error(
      `Elements buttons have duplicate host-level paint (count=${metrics.paintedButtonHostCount})`
    );
  }
  if (metrics.topbarOutOfBoundsCount > 0) {
    throw new Error(`Workspace topbar controls overflow the viewport (count=${metrics.topbarOutOfBoundsCount})`);
  }
  if (
    metrics.accountFlexWrap !== "nowrap" ||
    metrics.accountLabelHeight < 12 ||
    metrics.accountLabelButtonCenterDelta > 1.5 ||
    metrics.accountButtonCenterDelta > 1.5
  ) {
    throw new Error(
      `Workspace account controls are misaligned (wrap=${metrics.accountFlexWrap}, labelHeight=${metrics.accountLabelHeight}, labelDelta=${metrics.accountLabelButtonCenterDelta}, buttonDelta=${metrics.accountButtonCenterDelta})`
    );
  }
  if (
    metrics.activeToggleBackground !== metrics.brandBackground ||
    metrics.selectedTreeBackground !== metrics.selectedBackground ||
    metrics.activeEditorLineBackground !== metrics.activeLineBackgroundToken
  ) {
    throw new Error(
      `Workspace semantic accent states drifted: ${JSON.stringify({
        brand: metrics.brandBackground,
        activeToggle: metrics.activeToggleBackground,
        selected: metrics.selectedBackground,
        selectedTree: metrics.selectedTreeBackground,
        activeLine: metrics.activeLineBackgroundToken,
        editorLine: metrics.activeEditorLineBackground
      })}`
    );
  }
  if (
    metrics.panelRadius > 6.5 ||
    metrics.panelShadow !== "none" ||
    metrics.panelHeaderHeight > 39 ||
    metrics.workspacePadding !== "0px"
  ) {
    throw new Error(
      `Workspace editor density drifted: ${JSON.stringify({
        panelRadius: metrics.panelRadius,
        panelShadow: metrics.panelShadow,
        panelHeaderHeight: metrics.panelHeaderHeight,
        workspacePadding: metrics.workspacePadding
      })}`
    );
  }
}

async function assertElementsOverlays(page) {
  if (await page.locator("nve-tooltip:popover-open").count()) {
    throw new Error("Elements tooltip is open before its trigger is hovered");
  }

  const tooltipTrigger = page.locator(".ui-tooltip-trigger:visible").first();
  await tooltipTrigger.hover();
  await page.locator("nve-tooltip:popover-open").waitFor({ timeout: 3000 });
  if ((await page.locator("nve-tooltip:popover-open").count()) !== 1) {
    throw new Error("Elements tooltip did not open exactly once");
  }
  await page.mouse.move(600, 600);
  await page.waitForFunction(() => !document.querySelector("nve-tooltip:popover-open"));

  const pageIndicator = page.locator(".preview-page-indicator");
  await pageIndicator.click();
  const pageJump = page.locator("#preview-page-jump:popover-open");
  await pageJump.waitFor({ timeout: 3000 });
  const pageJumpMetrics = await pageJump.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const input = node.querySelector("input");
    return {
      inputValue: input?.value ?? "",
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight
    };
  });
  if (
    !/^\d+$/.test(pageJumpMetrics.inputValue) ||
    pageJumpMetrics.left < 0 ||
    pageJumpMetrics.top < 0 ||
    pageJumpMetrics.right > pageJumpMetrics.viewportWidth ||
    pageJumpMetrics.bottom > pageJumpMetrics.viewportHeight
  ) {
    throw new Error(`Elements page jump popover is invalid: ${JSON.stringify(pageJumpMetrics)}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#preview-page-jump:popover-open"));
}

async function assertPreviewPagination(page) {
  await page.waitForFunction(
    () => document.querySelectorAll(".pdf-frame .typst-page").length === 3,
    null,
    { timeout: 15000 }
  );

  const waitForPage = (current) =>
    page.waitForFunction(
      (expected) => {
        const label = document.querySelector(".preview-page-indicator")?.textContent || "";
        return label.includes(`${expected}/3`);
      },
      current,
      { timeout: 3000 }
    );

  const alignment = await page.evaluate(() => {
    const textBounds = (element) => {
      if (!element) return null;
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const title = textBounds(document.querySelector(".preview-title-group h2"));
    const indicator = textBounds(document.querySelector(".preview-page-indicator"));
    return {
      titleCenter: title ? (title.top + title.bottom) / 2 : null,
      indicatorCenter: indicator ? (indicator.top + indicator.bottom) / 2 : null
    };
  });
  if (
    alignment.titleCenter === null ||
    alignment.indicatorCenter === null ||
    Math.abs(alignment.titleCenter - alignment.indicatorCenter) > 1
  ) {
    throw new Error(`Preview title and page indicator are misaligned: ${JSON.stringify(alignment)}`);
  }

  await page.evaluate(() => {
    const frame = document.querySelector(".pdf-frame");
    if (frame) frame.scrollTop = 0;
  });
  await waitForPage(1);

  await page.evaluate(() => {
    const frame = document.querySelector(".pdf-frame");
    if (frame) frame.scrollTop = frame.scrollHeight - frame.clientHeight;
  });
  await waitForPage(3);

  await page.locator(".preview-page-indicator").click();
  const pageJump = page.locator("#preview-page-jump:popover-open");
  await pageJump.waitFor({ timeout: 3000 });
  await pageJump.locator("input").fill("2");
  await pageJump.locator("nve-button").click();
  await page.waitForFunction(() => !document.querySelector("#preview-page-jump:popover-open"));
  await waitForPage(2);

  const jumpMetrics = await page.evaluate(() => {
    const frame = document.querySelector(".pdf-frame");
    if (!frame) return null;
    return {
      scrollTop: frame.scrollTop,
      maxScrollTop: frame.scrollHeight - frame.clientHeight
    };
  });
  if (
    !jumpMetrics ||
    jumpMetrics.maxScrollTop <= 0 ||
    jumpMetrics.scrollTop <= 0 ||
    jumpMetrics.scrollTop >= jumpMetrics.maxScrollTop
  ) {
    throw new Error(`Preview page jump did not reach page 2: ${JSON.stringify(jumpMetrics)}`);
  }
}

async function assertMobileWorkspaceLayout(page) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const settings = document.querySelector(".panel-settings");
    const settingsRect = settings?.getBoundingClientRect();
    const settingsContent = settings?.querySelector(":scope > .panel-content");
    const cards = Array.from(
      settingsContent?.querySelectorAll(".settings-tab-panel nve-card.ui-card") ?? []
    );
    const visibleControls = Array.from(
      settings?.querySelectorAll("nve-input, nve-select, nve-button, nve-icon-button, nve-checkbox") ?? []
    ).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const outOfBoundsControls = visibleControls.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left < -0.5 || rect.right > viewportWidth + 0.5;
    });
    const clippedCards = cards.filter(
      (card) => card.scrollHeight > card.clientHeight + 2
    );
    const copyButton = Array.from(
      settings?.querySelectorAll("nve-button, nve-icon-button") ?? []
    ).find((node) =>
      /^(Copy|Copied)$/.test(
        node.getAttribute("aria-label") || node.textContent?.trim() || ""
      )
    );
    const copyRect = copyButton?.getBoundingClientRect();
    const topbarOutOfBounds = Array.from(
      document.querySelectorAll(".topbar nve-button, .topbar .workspace-project-menu-wrap")
    ).filter((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return rect.left < -0.5 || rect.right > viewportWidth + 0.5;
    });
    const settingsNavItems = Array.from(settings?.querySelectorAll(".settings-nav-item") ?? []);
    const minSettingsNavHeight = settingsNavItems.length
      ? Math.min(...settingsNavItems.map((node) => node.getBoundingClientRect().height))
      : 0;
    const backHeight = document.querySelector(".topbar-back-btn")?.getBoundingClientRect().height ?? 0;
    const viewHeight = document
      .querySelector(".workspace-view-menu-wrap .workspace-toolbar-toggle")
      ?.getBoundingClientRect().height ?? 0;
    const taskHeight = document
      .querySelector(".topbar.workspace .processing-task-trigger nve-icon-button")
      ?.getBoundingClientRect().height ?? 0;
    const brandVisible = (() => {
      const rect = document.querySelector(".topbar.workspace .topbar-brand-link")?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.height > 0;
    })();
    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      settingsLeft: settingsRect?.left ?? -1,
      settingsRight: settingsRect?.right ?? -1,
      settingsWidth: settingsRect?.width ?? -1,
      settingsContentOverflow: settingsContent
        ? settingsContent.scrollWidth - settingsContent.clientWidth
        : 999,
      cardCount: cards.length,
      clippedCardCount: clippedCards.length,
      copyButtonVisible: !!copyRect && copyRect.width > 0 && copyRect.height > 0,
      outOfBoundsControlCount: outOfBoundsControls.length,
      topbarOutOfBoundsCount: topbarOutOfBounds.length,
      minSettingsNavHeight,
      backHeight,
      viewHeight,
      taskHeight,
      brandVisible
    };
  });
  if (
    metrics.documentScrollWidth > metrics.viewportWidth + 1 ||
    metrics.settingsLeft > 10 ||
    metrics.settingsRight < metrics.viewportWidth - 10 ||
    metrics.settingsWidth < metrics.viewportWidth - 20
  ) {
    throw new Error(`Mobile workspace does not fill the viewport: ${JSON.stringify(metrics)}`);
  }
  if (
    metrics.settingsContentOverflow > 1 ||
    metrics.outOfBoundsControlCount > 0 ||
    metrics.topbarOutOfBoundsCount > 0
  ) {
    throw new Error(`Mobile settings controls overflow: ${JSON.stringify(metrics)}`);
  }
  if (
    metrics.cardCount < 2 ||
    metrics.clippedCardCount > 0 ||
    !metrics.copyButtonVisible
  ) {
    throw new Error(`Mobile settings content is clipped or missing: ${JSON.stringify(metrics)}`);
  }
  if (
    metrics.minSettingsNavHeight < 43 ||
    metrics.backHeight < 39 ||
    metrics.viewHeight < 39 ||
    metrics.taskHeight < 39 ||
    metrics.brandVisible
  ) {
    throw new Error(`Mobile workspace chrome is not touch-ready: ${JSON.stringify(metrics)}`);
  }
}

async function assertMobileHomeLayout(page) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const rect = (selector) => {
      const bounds = document.querySelector(selector)?.getBoundingClientRect();
      return bounds
        ? { left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height }
        : null;
    };
    const hero = document.querySelector(".home-hero");
    const actionRects = Array.from(document.querySelectorAll(".home-hero-actions nve-button")).map(
      (node) => {
        const bounds = node.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height };
      }
    );
    const menuItems = Array.from(document.querySelectorAll(".app-navigation-menu nve-menu-item"));
    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      contentScrollWidth: document.querySelector(".app-content")?.scrollWidth ?? 0,
      heroColumns: hero ? getComputedStyle(hero).gridTemplateColumns.trim().split(/\s+/).length : 0,
      hero: rect(".home-hero"),
      copy: rect(".home-hero-copy"),
      visual: rect(".home-product-visual"),
      actionRects,
      brandHeight: rect(".topbar-brand-link")?.height ?? 0,
      menuHeight: rect(".topbar-nav-mobile > nve-button")?.height ?? 0,
      minMenuItemHeight: menuItems.length
        ? Math.min(...menuItems.map((node) => node.getBoundingClientRect().height))
        : 0
    };
  });
  const horizontalBounds = [metrics.hero, metrics.copy, metrics.visual, ...metrics.actionRects].filter(
    Boolean
  );
  if (
    metrics.heroColumns !== 1 ||
    !metrics.hero ||
    !metrics.copy ||
    !metrics.visual ||
    metrics.copy.width < metrics.hero.width - 1 ||
    horizontalBounds.some(
      (bounds) => bounds.left < -0.5 || bounds.right > metrics.viewportWidth + 0.5
    ) ||
    metrics.documentScrollWidth > metrics.viewportWidth + 1 ||
    metrics.contentScrollWidth > metrics.viewportWidth + 1
  ) {
    throw new Error(`Mobile home layout is not contained: ${JSON.stringify(metrics)}`);
  }
  if (
    metrics.actionRects.length < 2 ||
    metrics.actionRects.some((bounds) => bounds.width < 1 || bounds.height < 43) ||
    metrics.brandHeight < 43 ||
    metrics.menuHeight < 43 ||
    metrics.minMenuItemHeight < 43
  ) {
    throw new Error(`Mobile home actions are not touch-ready: ${JSON.stringify(metrics)}`);
  }
}

async function assertMobileHelpLayout(page) {
  const metrics = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const article = document.querySelector(".help-article")?.getBoundingClientRect();
    const picker = document.querySelector(".help-topic-picker select")?.getBoundingClientRect();
    return {
      viewportWidth,
      contentScrollWidth: document.querySelector(".app-content")?.scrollWidth ?? 0,
      desktopTopicsDisplay: getComputedStyle(document.querySelector(".help-topic-nav")).display,
      pickerDisplay: getComputedStyle(document.querySelector(".help-topic-picker")).display,
      pickerHeight: picker?.height ?? 0,
      articleLeft: article?.left ?? -1,
      articleRight: article?.right ?? -1,
      articleTop: article?.top ?? -1
    };
  });
  if (
    metrics.desktopTopicsDisplay !== "none" ||
    metrics.pickerDisplay === "none" ||
    metrics.pickerHeight < 43 ||
    metrics.articleLeft < -0.5 ||
    metrics.articleRight > metrics.viewportWidth + 0.5 ||
    metrics.articleTop < 0 ||
    metrics.contentScrollWidth > metrics.viewportWidth + 1
  ) {
    throw new Error(`Mobile help layout is not usable: ${JSON.stringify(metrics)}`);
  }
}

async function assertStandardPageLayout(page) {
  const metrics = await page.evaluate(() => {
    const resolveBackground = (value) => {
      const probe = document.createElement("span");
      probe.style.background = value;
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    };
    const pageNode = document.querySelector(".app-page");
    const pageRect = pageNode?.getBoundingClientRect();
    const controls = Array.from(
      document.querySelectorAll(
        ".app-page nve-input, .app-page nve-select, .app-page nve-button, .app-page nve-checkbox"
      )
    ).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    let overlappingControlPairs = 0;
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
        const left = controls[i].getBoundingClientRect();
        const right = controls[j].getBoundingClientRect();
        const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        if (overlapX > 1 && overlapY > 1) overlappingControlPairs += 1;
      }
    }
    const collapsedCardLayouts = Array.from(
      document.querySelectorAll(".app-page nve-card-content.ui-card-layout")
    ).filter((node) => {
      if (node.closest(".projects-table-card")) return false;
      const style = getComputedStyle(node);
      return Math.max(parseFloat(style.rowGap) || 0, parseFloat(style.columnGap) || 0) < 4;
    });
    const projectRow = document.querySelector(".projects-row");
    const createCard = document.querySelector(".projects-create-card");
    return {
      pageLeft: pageRect?.left ?? -1,
      pageRight: pageRect?.right ?? -1,
      viewportWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      topbarOverflowCount: Array.from(
        document.querySelectorAll(".topbar nve-button, .topbar nve-icon-button, .topbar nve-dropdown")
      ).filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return rect.left < -0.5 || rect.right > document.documentElement.clientWidth + 0.5;
      }).length,
      overlappingControlPairs,
      collapsedCardLayoutCount: collapsedCardLayouts.length,
      projectRowRadius: projectRow ? parseFloat(getComputedStyle(projectRow).borderRadius) || 0 : 0,
      projectRowShadow: projectRow ? getComputedStyle(projectRow).boxShadow : "none",
      brandBackground: resolveBackground("var(--toss-brand-primary)"),
      createCardAccent: createCard ? getComputedStyle(createCard).borderTopColor : "missing"
    };
  });
  if (
    metrics.pageLeft < -0.5 ||
    metrics.pageRight > metrics.viewportWidth + 0.5 ||
    metrics.documentScrollWidth > metrics.viewportWidth + 1 ||
    metrics.topbarOverflowCount > 0
  ) {
    throw new Error(`Standard page overflows the viewport: ${JSON.stringify(metrics)}`);
  }
  if (metrics.overlappingControlPairs > 0) {
    throw new Error(`Standard page controls overlap (pairs=${metrics.overlappingControlPairs})`);
  }
  if (metrics.collapsedCardLayoutCount > 0) {
    throw new Error(`Standard page card spacing collapsed (count=${metrics.collapsedCardLayoutCount})`);
  }
  if (
    metrics.projectRowRadius > 0.5 ||
    metrics.projectRowShadow !== "none" ||
    metrics.createCardAccent !== metrics.brandBackground
  ) {
    throw new Error(
      `Project page design system drifted: ${JSON.stringify({
        rowRadius: metrics.projectRowRadius,
        rowShadow: metrics.projectRowShadow,
        createAccent: metrics.createCardAccent,
        brand: metrics.brandBackground
      })}`
    );
  }
}

async function acceptPrompt(page, trigger, value) {
  let seenPrompt = false;
  page.once("dialog", async (dialog) => {
    if (dialog.type() !== "prompt") throw new Error(`Expected prompt, got ${dialog.type()}`);
    seenPrompt = true;
    await dialog.accept(value);
  });
  await trigger();
  await wait(200);
  if (seenPrompt) return;
  const dialog = page
    .locator(".ui-dialog")
    .filter({ has: page.locator("input, textarea") })
    .last();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
    const modalInput = dialog.locator("input, textarea").first();
    await modalInput.waitFor({ timeout: 5000 });
    await modalInput.fill(value);
    let saveButton = dialog.getByRole("button", {
      name: /(Save|Create|OK|Confirm|确认|保存|创建|确定)/i
    });
    if ((await saveButton.count()) === 0) {
      saveButton = dialog.locator("button");
    }
    if ((await saveButton.count()) > 0) {
      await saveButton.last().click();
      return;
    }
  }
  throw new Error("Expected prompt dialog/modal was not shown");
}

async function acceptConfirm(page, trigger, accept = true) {
  let seenConfirm = false;
  page.once("dialog", async (dialog) => {
    if (dialog.type() !== "confirm") throw new Error(`Expected confirm, got ${dialog.type()}`);
    seenConfirm = true;
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await trigger();
  await wait(200);
  if (seenConfirm) return;
  const dialog = page.locator(".ui-dialog").last();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
    const actionPattern = accept
      ? /(Delete|Confirm|OK|Revoke|确认|删除|撤销|确定)/i
      : /(Cancel|No|取消)/i;
    const actionButton = dialog.getByRole("button", { name: actionPattern }).last();
    if ((await actionButton.count()) > 0) {
      await actionButton.click();
      return;
    }
  }
  const actionPattern = accept
    ? /^(Delete|Confirm|OK|Revoke|确认|删除|撤销)$/i
    : /^(Cancel|No|取消)$/i;
  const actionButton = page.locator("button", { hasText: actionPattern }).first();
  if ((await actionButton.count()) > 0 && (await actionButton.isVisible().catch(() => false))) {
    await actionButton.click();
    return;
  }
  throw new Error("Expected confirm dialog/modal was not shown");
}

function treeNode(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .locator(".tree-node", {
      has: page.locator(".tree-label", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    })
    .first();
}

function contextMenuAction(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .locator(".context-menu-floating:visible")
    .last()
    .locator("nve-menu-item, button")
    .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    .first();
}

async function ensureDirectoryExpanded(page, name) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const row = treeNode(page, name);
    await row.waitFor({ timeout: 4000 });
    const toggle = row.locator(".tree-toggle").first();
    const toggleLabel = (await toggle.getAttribute("aria-label")) || "";
    if (toggleLabel.startsWith("Collapse ")) return;
    if (toggleLabel.startsWith("Expand ")) {
      await row.locator(".tree-label").first().click();
      await wait(120);
      continue;
    }
    await wait(100);
  }
  throw new Error(`directory did not expand: ${name}`);
}

async function editorText(page) {
  return page.locator(".cm-content").innerText();
}

async function waitForEditorContains(page, snippet, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await editorText(page)).includes(snippet)) return;
    await wait(150);
  }
  throw new Error(`editor missing snippet: ${snippet}`);
}

async function openContextMenu(page, name, method = "button") {
  const row = treeNode(page, name);
  if (method === "right") await row.click({ button: "right" });
  else await row.locator(".mini").first().click();
  await page.locator(".context-menu-floating").first().waitFor({ timeout: 10000 });
}

async function dragHandleX(page, handle, deltaX, label = "handle") {
  const box = await handle.boundingBox();
  if (!box) throw new Error(`missing draggable handle: ${label}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 10 });
  await page.mouse.up();
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext({
  viewport: { width: 1620, height: 1020 },
  locale: "en-US"
});
const contextB = await browser.newContext({
  viewport: { width: 1620, height: 1020 },
  locale: "en-US"
});
await contextA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
await contextA.addInitScript(() => {
  window.__tossTypstCompileFrames = [];
  window.__tossTypstCompileRequests = [];
  window.__tossTypstPrewarmRequests = 0;
  const NativeWorker = window.Worker;
  window.Worker = class InstrumentedWorker extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || typeof data.id !== "number" || !data.vectorMode) return;
        window.__tossTypstCompileFrames.push({
          mode: data.vectorMode,
          vectorBytes: data.vectorBytes?.byteLength ?? 0
        });
      });
    }

    postMessage(data, ...rest) {
      if (data?.kind === "prewarm") {
        window.__tossTypstPrewarmRequests += 1;
      }
      if (data?.kind === "compile") {
        window.__tossTypstCompileRequests.push({
          resetWorkspace: data.resetWorkspace === true,
          documentUpserts: data.documentUpserts?.length ?? 0,
          documentDeletes: data.documentDeletes?.length ?? 0,
          assetUpserts: data.assetUpserts?.length ?? 0,
          assetDeletes: data.assetDeletes?.length ?? 0,
          fontCount: data.fontData?.length ?? 0
        });
      }
      return super.postMessage(data, ...rest);
    }
  };
});
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
const browserErrors = [];
for (const page of [pageA, pageB]) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !text.includes("401 (Unauthorized)")) {
      browserErrors.push(`console:${text}`);
    }
  });
  page.on("pageerror", (err) => {
    browserErrors.push(`pageerror:${String(err)}`);
  });
}

const artifacts = [];
let currentStep = "init";

try {
  currentStep = "mobile-public-layout";
  await pageA.setViewportSize({ width: 320, height: 568 });
  await pageA.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pageA.locator(".home-hero").waitFor({ timeout: 30000 });
  await pageA.locator(".topbar-nav-mobile > nve-button").click();
  await pageA.locator(".app-navigation-menu nve-menu-item").first().waitFor({ timeout: 10000 });
  await assertMobileHomeLayout(pageA);
  await pageA.evaluate(() => document.getElementById("app-navigation-menu")?.hidePopover());
  await pageA.locator(".home-hero-actions nve-button").last().click({ trial: true });
  const mobileHomeShot = path.join(outDir, "00-home-mobile.png");
  await pageA.screenshot({ path: mobileHomeShot, fullPage: true });
  artifacts.push(mobileHomeShot);

  await pageA.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const mobileTopicPicker = pageA.locator(".help-topic-picker select");
  await mobileTopicPicker.waitFor({ timeout: 30000 });
  await assertMobileHelpLayout(pageA);
  if ((await mobileTopicPicker.locator("option").count()) > 1) {
    await mobileTopicPicker.selectOption({ index: 1 });
    await pageA.waitForFunction(() => new URLSearchParams(location.search).has("topic"));
  }
  const mobileHelpShot = path.join(outDir, "00-help-mobile.png");
  await pageA.screenshot({ path: mobileHelpShot, fullPage: true });
  artifacts.push(mobileHelpShot);
  await pageA.setViewportSize({ width: 1620, height: 1020 });

  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Owner");
  const collaborator = await registerOrLogin(collaboratorEmail, collaboratorPassword, "Collaborator");
  const project = await bearerApi("POST", "/v1/projects", owner.sessionToken, {
    name: `Smoke Project ${runId}`
  });
  const projectId = project.id;
  const writeShare = await bearerApi("POST", `/v1/projects/${projectId}/share-links`, owner.sessionToken, {
    permission: "write"
  });
  await bearerApi("POST", `/v1/share/${encodeURIComponent(writeShare.token)}/join`, collaborator.sessionToken);

  let optionalFontBytes = null;
  if (fontPath) {
    try {
      optionalFontBytes = new Uint8Array(await fs.readFile(fontPath));
    } catch {
      optionalFontBytes = null;
    }
  }
  const simpleSvg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2f7d4a"/></svg>'
  );
  const bibText =
    "@article{smoke2026,\n  title = {Headless Smoke},\n  author = {Tester, A.}\n}\n";
  const rawBinary = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 255, 254, 253, 252]);
  const tempUploadFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "typst-upload-")), "upload.typ");
  await fs.writeFile(tempUploadFile, "= Uploaded From UI\n\nThis file came from file chooser.\n", "utf8");

  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "chapters",
    kind: "directory"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "figures",
    kind: "directory"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "fonts",
    kind: "directory"
  });
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("chapters/intro.typ")}`,
    owner.sessionToken,
    { content: "#let intro = [Realtime include content.]" }
  );
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    owner.sessionToken,
    {
      content: [
        "#set page(width: 16cm, height: 9cm)",
        '#import "@preview/cetz:0.4.2": *',
        '#import "chapters/intro.typ": intro',
        '#set text(font: "Libertinus Serif")',
        "",
        "= Headless Functional Smoke",
        "",
        "#intro",
        "",
        '#image("figures/shape.svg", width: 20pt)',
        "",
        "#pagebreak()",
        "= Smoke Page Two",
        "",
        "#pagebreak()",
        "= Smoke Page Three"
      ].join("\n")
    }
  );
  await bearerApi("PATCH", `/v1/projects/${projectId}/settings/entry-file`, owner.sessionToken, {
    entry_file_path: "main.typ"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
    path: "figures/shape.svg",
    content_base64: Buffer.from(simpleSvg).toString("base64"),
    content_type: "image/svg+xml"
  });
  if (optionalFontBytes) {
    await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
      path: "fonts/Custom.ttf",
      content_base64: Buffer.from(optionalFontBytes).toString("base64"),
      content_type: "font/ttf"
    });
  }
  await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
    path: "blob.bin",
    content_base64: Buffer.from(rawBinary).toString("base64"),
    content_type: "application/octet-stream"
  });
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("refs/library.bib")}`,
    owner.sessionToken,
    { content: bibText }
  );

  await login(pageA, owner.email, owner.password);
  currentStep = "login-owner";
  await pageA.setViewportSize({ width: 390, height: 844 });
  await assertStandardPageLayout(pageA);
  const mobileTaskTrigger = pageA.locator(".processing-task-trigger nve-icon-button");
  await mobileTaskTrigger.waitFor({ timeout: 10000 });
  await mobileTaskTrigger.click();
  const mobileTaskCenter = pageA.locator(".processing-task-center");
  await mobileTaskCenter.waitFor({ timeout: 10000 });
  await mobileTaskCenter.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
  );
  const mobileTaskMetrics = await mobileTaskCenter.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const close = node.querySelector(".processing-task-header nve-icon-button")?.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: document.documentElement.clientWidth,
      closeLeft: close?.left ?? -1,
      closeRight: close?.right ?? -1,
      closeWidth: close?.width ?? 0,
      closeHeight: close?.height ?? 0
    };
  });
  if (
    mobileTaskMetrics.left < -0.5 ||
    mobileTaskMetrics.right > mobileTaskMetrics.viewportWidth + 0.5 ||
    mobileTaskMetrics.closeLeft < mobileTaskMetrics.left - 0.5 ||
    mobileTaskMetrics.closeRight > mobileTaskMetrics.right + 0.5 ||
    mobileTaskMetrics.closeWidth < 43 ||
    mobileTaskMetrics.closeHeight < 43
  ) {
    throw new Error(`Mobile task center is not usable: ${JSON.stringify(mobileTaskMetrics)}`);
  }
  const mobileTaskShot = path.join(outDir, "00a-task-center-mobile.png");
  await pageA.screenshot({ path: mobileTaskShot, fullPage: true });
  artifacts.push(mobileTaskShot);
  await pageA.locator(".processing-task-header nve-icon-button").click();
  const mobileProjectsShot = path.join(outDir, "00-projects-mobile.png");
  await pageA.screenshot({ path: mobileProjectsShot, fullPage: true });
  artifacts.push(mobileProjectsShot);
  await pageA.setViewportSize({ width: 1620, height: 1020 });
  await login(pageB, collaborator.email, collaborator.password);
  currentStep = "login-collaborator";
  await openWorkspace(pageA, projectId);
  currentStep = "open-workspace-owner";
  await openWorkspace(pageB, projectId);
  currentStep = "open-workspace-collab";
  await waitForActiveFile(pageA, "main.typ", 15000);
  await waitForActiveFile(pageB, "main.typ", 15000);
  await waitForCanvas(pageA, 60000);
  const prewarmRequests = await pageA.evaluate(() => window.__tossTypstPrewarmRequests);
  if (prewarmRequests < 1) {
    throw new Error("Typst compiler prewarm did not run before the initial preview");
  }
  await assertVisiblePreviewPage(pageA);
  await assertWorkspaceLayout(pageA);
  currentStep = "preview-pagination";
  await assertPreviewPagination(pageA);
  await assertElementsOverlays(pageA);
  await ensureDirectoryExpanded(pageA, "refs");
  await pageA.locator(".tree-label", { hasText: "library.bib" }).first().click();
  currentStep = "editable-bib-file";
  await waitForEditorContains(pageA, "@article{smoke2026", 12000);
  await pageA.locator(".tree-label", { hasText: "main.typ" }).first().click();
  await waitForActiveFile(pageA, "main.typ", 10000);

  const shot1 = path.join(outDir, "01-workspace-load.png");
  await pageA.screenshot({ path: shot1, fullPage: true });
  artifacts.push(shot1);

  const widthsBefore = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    const preview = document.querySelector(".panel-preview")?.getBoundingClientRect().width ?? 0;
    return { files, editor, preview };
  });
  if ((await pageA.locator(".panel-preview").count()) === 0) {
    await pageA.getByRole("button", { name: "Preview" }).click();
  }
  if ((await pageA.locator(".panel-files").count()) === 0) {
    await pageA.getByRole("button", { name: "Files" }).click();
  }
  currentStep = "resize-layout";
  const filesHandle = pageA.locator(".workspace-stage > .panel-resizer").first();
  const splitHandle = pageA.locator(".center-split > .panel-resizer").first();
  await dragHandleX(pageA, filesHandle, 64, "files resizer");
  await dragHandleX(pageA, splitHandle, -96, "editor-preview resizer");
  await wait(220);
  const widthsAfterDrag = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    const preview = document.querySelector(".panel-preview")?.getBoundingClientRect().width ?? 0;
    return { files, editor, preview };
  });
  if (widthsAfterDrag.files < widthsBefore.files + 28) {
    throw new Error("files panel resize did not apply");
  }
  if (widthsAfterDrag.editor > widthsBefore.editor - 40) {
    throw new Error("editor/preview split resize did not apply");
  }
  await pageA.waitForFunction(
    () => {
      const raw = window.localStorage.getItem("workspace.layout.v2");
      const filesWidth = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
      if (!raw || filesWidth <= 0) return false;
      try {
        const stored = JSON.parse(raw);
        return Math.abs(Number(stored.filesWidth) - filesWidth) <= 6;
      } catch {
        return false;
      }
    },
    null,
    { timeout: 2000 }
  );

  await pageA.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await pageA.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
  await waitForCanvas(pageA, 60000);
  const widthsAfterReload = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    return { files, editor };
  });
  if (Math.abs(widthsAfterReload.files - widthsAfterDrag.files) > 6) {
    throw new Error("files panel width was not persisted");
  }

  const beforeChecksum = await canvasChecksum(pageA);
  currentStep = "realtime-edit";
  await pageA.locator(".cm-content").click();
  await pageA.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await pageA.keyboard.type("Realtime update from owner.\n", { delay: 4 });
  await waitForEditorContains(pageB, "Realtime update from owner.");
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const next = await canvasChecksum(pageA);
    if (next !== beforeChecksum && next > 0) break;
    await wait(200);
  }
  const afterChecksum = await canvasChecksum(pageA);
  if (afterChecksum === beforeChecksum || afterChecksum === 0) {
    throw new Error("Preview did not update after realtime edit");
  }
  const incrementalFrame = await pageA.evaluate(() =>
    window.__tossTypstCompileFrames.find(
      (frame) => frame.mode === "delta" && frame.vectorBytes > 0
    )
  );
  if (!incrementalFrame) {
    throw new Error("Typst preview edit did not use an incremental vector delta");
  }
  const incrementalRequest = await pageA.evaluate(() =>
    window.__tossTypstCompileRequests.findLast(
      (request) =>
        !request.resetWorkspace &&
        request.documentUpserts === 1 &&
        request.documentDeletes === 0
    )
  );
  if (
    !incrementalRequest ||
    incrementalRequest.assetUpserts !== 0 ||
    incrementalRequest.assetDeletes !== 0 ||
    incrementalRequest.fontCount !== 0
  ) {
    throw new Error("Typst edit resent a full workspace instead of a one-document patch");
  }

  // Equal-length replacements previously produced a new Typst artifact that
  // could be mistaken for the already-rendered one by a sparse byte signature.
  await pageA.evaluate(() => {
    const canvas = document.querySelector(".pdf-frame canvas");
    window.__tossPreviewBeforeEqualLengthEdit = {
      canvas,
      cacheKey: canvas?.dataset.typstCacheKey || ""
    };
  });
  await pageA.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await pageA.keyboard.press("Shift+ArrowRight");
  await pageA.keyboard.type("X");
  await pageA.waitForFunction(
    () => {
      const current = document.querySelector(".pdf-frame canvas");
      const previous = window.__tossPreviewBeforeEqualLengthEdit;
      if (!current || !previous) return false;
      const cacheKey = current.dataset.typstCacheKey || "";
      return (
        (!!cacheKey && cacheKey !== previous.cacheKey) ||
        current !== previous.canvas
      );
    },
    null,
    { timeout: 15000, polling: "raf" }
  );

  await pageA.evaluate(() => {
    window.__tossSaveDefaultPrevented = null;
    const observeSave = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      window.removeEventListener("keydown", observeSave);
      window.__tossSaveDefaultPrevented = event.defaultPrevented;
    };
    window.addEventListener("keydown", observeSave);
  });
  await pageA.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await wait(100);
  const saveDefaultPrevented = await pageA.evaluate(() => window.__tossSaveDefaultPrevented);
  if (saveDefaultPrevented !== true) {
    throw new Error("Cmd/Ctrl+S was not handled by the editor");
  }

  await openContextMenu(pageA, "chapters", "right");
  currentStep = "context-new-file";
  await acceptPrompt(
    pageA,
    () => contextMenuAction(pageA, "New File").click(),
    contextCreatedName
  );
  currentStep = "verify-created-file";
  await ensureDirectoryExpanded(pageA, "chapters");
  let contextCreatedActualName = contextCreatedName;
  const createdPrimary = pageA.locator(".tree-label", { hasText: contextCreatedName }).first();
  if ((await createdPrimary.count()) > 0 && (await createdPrimary.isVisible().catch(() => false))) {
    contextCreatedActualName = contextCreatedName;
  } else {
    const createdFallback = pageA.locator(".tree-label", { hasText: "untitled.typ" }).first();
    await createdFallback.waitFor({ timeout: 20000 });
    contextCreatedActualName = "untitled.typ";
  }
  await pageA.locator(".tree-label", { hasText: contextCreatedActualName }).first().click();
  await waitForActiveFile(pageA, contextCreatedActualName, 10000);

  try {
    await openContextMenu(pageA, contextCreatedActualName, "right");
    currentStep = "context-rename-file";
    await acceptPrompt(
      pageA,
      () => contextMenuAction(pageA, "Rename").click(),
      contextRenamedName
    );
    await waitForActiveFile(pageA, contextRenamedName, 10000);
    currentStep = "verify-renamed-file";
    await pageA
      .locator(".tree-label", { hasText: path.basename(contextRenamedPath) })
      .first()
      .waitFor({ timeout: 10000 });
  } catch (err) {
    browserErrors.push(`rename-step:${String(err)}`);
    const createdLabel = pageA.locator(".tree-label", { hasText: contextCreatedActualName }).first();
    if ((await createdLabel.count()) > 0 && (await createdLabel.isVisible().catch(() => false))) {
      await createdLabel.click();
    } else {
      const renamedLabel = pageA.locator(".tree-label", { hasText: contextRenamedName }).first();
      if ((await renamedLabel.count()) > 0 && (await renamedLabel.isVisible().catch(() => false))) {
        await renamedLabel.click();
      }
    }
  }

  const fileChooserPromise = pageA.waitForEvent("filechooser");
  currentStep = "upload-file";
  await pageA.getByRole("button", { name: "Upload" }).first().click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(tempUploadFile);
  const uploadedFileName = path.basename(tempUploadFile);
  await pageA
    .locator(".tree-label", { hasText: uploadedFileName })
    .first()
    .waitFor({ timeout: 10000 });
  await pageA.locator(".tree-label", { hasText: uploadedFileName }).first().click();
  await pageA.getByText("Uploaded From UI").waitFor({ timeout: 10000 });

  await openContextMenu(pageA, uploadedFileName);
  currentStep = "context-delete-uploaded-file";
  await acceptConfirm(
    pageA,
    () => contextMenuAction(pageA, "Delete").click()
  );
  await pageA
    .locator(".tree-label", { hasText: uploadedFileName })
    .first()
    .waitFor({ state: "hidden", timeout: 10000 });

  await ensureDirectoryExpanded(pageA, "figures");
  await pageA.locator(".tree-label", { hasText: "shape.svg" }).first().click();
  currentStep = "svg-file-preview";
  await pageA.locator(".file-preview-image").first().waitFor({ timeout: 10000 });
  const svgShowsLoading = await pageA.evaluate(() => {
    const metaSmall = document.querySelector(".file-preview .file-preview-meta small");
    const text = (metaSmall?.textContent || "").toLowerCase();
    return text.includes("loading") || text.includes("加载");
  });
  if (svgShowsLoading) {
    throw new Error("SVG preview still reports loading state after file selection");
  }

  await pageA.locator(".tree-label", { hasText: "blob.bin" }).first().click();
  currentStep = "unsupported-file-preview";
  await pageA.getByText("This file is not editable in web editor. Edit offline and sync with Git.").waitFor({
    timeout: 10000
  });
  if ((await pageA.locator(".file-icon").count()) < 1) {
    throw new Error("unknown file icon is not visible for unsupported file types");
  }

  const archiveDownloadPromise = pageA.waitForEvent("download");
  currentStep = "download-archive";
  await pageA.getByRole("button", { name: "Download ZIP" }).click();
  const archiveDownload = await archiveDownloadPromise;
  const archivePath = path.join(outDir, "archive.zip");
  await archiveDownload.saveAs(archivePath);
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size < 100) {
    throw new Error("Archive download is unexpectedly small");
  }

  await pageA.getByRole("button", { name: "Settings" }).click();
  currentStep = "open-settings";
  const settingsPanelInfo = await pageA.evaluate(() => {
    const panel = document.querySelector(".panel-settings .panel-content");
    const entrySelect = document.querySelector(".panel-settings select");
    if (!panel || !entrySelect) {
      return {
        ok: false,
        hasPanel: !!panel,
        hasEntrySelect: !!entrySelect
      };
    }
    const overflowY = getComputedStyle(panel).overflowY;
    const optionCount = entrySelect.querySelectorAll("option").length;
    return { ok: true, overflowY, optionCount };
  });
  if (!settingsPanelInfo.ok) {
    throw new Error(
      `settings panel controls missing (panel=${settingsPanelInfo.hasPanel}, entrySelect=${settingsPanelInfo.hasEntrySelect})`
    );
  }
  if (!["auto", "scroll"].includes(settingsPanelInfo.overflowY)) {
    throw new Error(`settings panel is not vertically scrollable (overflowY=${settingsPanelInfo.overflowY})`);
  }
  if (settingsPanelInfo.optionCount < 1) {
    throw new Error("entry file select has no options");
  }
  await openSettingsStorage(pageA);
  const copyButtonBefore = pageA.getByRole("button", { name: "Copy" }).first();
  await copyButtonBefore.click();
  await pageA.getByRole("button", { name: "Copied" }).first().waitFor({ timeout: 3000 });
  await bearerApi("POST", `/v1/projects/${projectId}/revisions`, owner.sessionToken, {
    summary: "Headless UI checkpoint"
  });
  await pageA.getByRole("button", { name: "Revisions" }).click();
  currentStep = "open-revisions";
  let historyCount = 0;
  for (let i = 0; i < 25; i += 1) {
    historyCount = await pageA.locator(".history-item").count();
    if (historyCount > 0) break;
    await wait(200);
  }
  if (historyCount < 1) {
    await openWorkspace(pageA, projectId);
    await pageA.getByRole("button", { name: "Revisions" }).click();
    for (let i = 0; i < 25; i += 1) {
      historyCount = await pageA.locator(".history-item").count();
      if (historyCount > 0) break;
      await wait(200);
    }
  }
  if (historyCount < 1) throw new Error("No revisions available");
  const historyBorder = await pageA.locator(".history-item").first().evaluate((host) => {
    const internal = host.shadowRoot?.querySelector("[internal-host]");
    return internal ? getComputedStyle(internal).borderTopWidth : "0px";
  });
  if (Number.parseFloat(historyBorder) < 1) {
    throw new Error(`Revision item has no visible boundary (${historyBorder})`);
  }
  await pageA.locator(".history-item").first().click();
  await pageA.waitForFunction(
    () => {
      const selected = document.querySelector(
        ".history-item.active, .history-item.selected, .history-item[aria-selected='true']"
      );
      return !!selected;
    },
    undefined,
    { timeout: 10000 }
  );
  await pageA.getByRole("button", { name: "Revisions" }).click();
  await waitForCanvas(pageA, 20000);
  await assertVisiblePreviewPage(pageA);

  const shot2 = path.join(outDir, "02-realtime-and-fileops.png");
  await pageA.screenshot({ path: shot2, fullPage: true });
  artifacts.push(shot2);

  currentStep = "mobile-settings-layout";
  await pageA.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  await pageA.getByRole("button", { name: "View" }).click();
  await pageA.getByRole("menuitem", { name: "Settings" }).click();
  await openSettingsStorage(pageA);
  await assertMobileWorkspaceLayout(pageA);
  const mobileSettingsShot = path.join(outDir, "02b-mobile-settings.png");
  await pageA.screenshot({ path: mobileSettingsShot, fullPage: true });
  artifacts.push(mobileSettingsShot);
  await pageA.setViewportSize({ width: 1620, height: 1020 });
  await wait(200);

  await pageA.getByRole("button", { name: "Logout" }).click();
  await pageA.getByPlaceholder("Email").waitFor({ timeout: 10000 });

  const shot3 = path.join(outDir, "03-logout.png");
  await pageA.screenshot({ path: shot3, fullPage: true });
  artifacts.push(shot3);

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        projectId,
        screenshots: artifacts,
        browserErrors
      },
      null,
      2
    )
  );
} catch (error) {
  const shot = path.join(outDir, "99-failure.png");
  await pageA.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl,
        screenshots: [...artifacts, shot],
        step: currentStep,
        error: String(error),
        stack: error?.stack,
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
