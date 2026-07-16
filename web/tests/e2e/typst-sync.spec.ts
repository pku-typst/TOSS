import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SYNC_SOURCE = [
  "#set page(width: 420pt, height: 220pt, margin: 0pt)",
  "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-FIRST]]",
  "#pagebreak()",
  "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-SECOND]]",
  "#pagebreak()",
  "#place(top + left, dx: 40pt, dy: 60pt)[#text(size: 40pt)[SYNC-THIRD]]"
].join("\n");

async function createSyncProject(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `typst-sync-${runId}@example.com`;
  const password = "TypstSync1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `typst-sync-${runId}`.slice(0, 32),
      display_name: "Typst Sync Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const headers = { authorization: `Bearer ${session.session_token}` };
  const projectResponse = await request.post("/v1/projects", {
    headers,
    data: { name: `Typst Sync ${runId}` }
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  const documentResponse = await request.put(
    `/v1/projects/${project.id}/documents/by-path/${encodeURIComponent("main.typ")}`,
    { headers, data: { content: SYNC_SOURCE } }
  );
  expect(documentResponse.ok()).toBeTruthy();
  return { email, password, projectId: project.id as string };
}

async function clickEditorToken(page: Page, token: string) {
  const point = await page.evaluate((value) => {
    const line = Array.from(document.querySelectorAll<HTMLElement>(".cm-line")).find((candidate) =>
      candidate.textContent?.includes(value)
    );
    if (!line) return null;
    const tokenStart = line.textContent?.indexOf(value) ?? -1;
    if (tokenStart < 0) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let startNode: Text | null = null;
    let endNode: Text | null = null;
    let startOffset = 0;
    let endOffset = 0;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const next = consumed + node.data.length;
      if (!startNode && tokenStart >= consumed && tokenStart < next) {
        startNode = node;
        startOffset = tokenStart - consumed;
      }
      const tokenEnd = tokenStart + value.length;
      if (tokenEnd > consumed && tokenEnd <= next) {
        endNode = node;
        endOffset = tokenEnd - consumed;
        break;
      }
      consumed = next;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, token);
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

async function clickRenderedInk(page: Page, pageOffset: number) {
  const point = await page.evaluate((offset) => {
    const pageElement = document.querySelector<HTMLElement>(
      `.typst-page[data-typst-page-offset="${offset}"]`
    );
    const canvas = pageElement?.querySelector("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context || canvas.width < 1 || canvas.height < 1) return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const candidates: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index + 3] > 160 && pixels[index] + pixels[index + 1] + pixels[index + 2] < 240) {
          candidates.push({ x, y });
        }
      }
    }
    if (candidates.length === 0) return null;
    const pixel = candidates[Math.floor(candidates.length / 2)];
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((pixel.x + 0.5) / canvas.width) * rect.width,
      y: rect.top + ((pixel.y + 0.5) / canvas.height) * rect.height
    };
  }, pageOffset);
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

test("synchronizes source and canvas positions without PDF export invalidating the mapping", async ({
  page,
  request
}) => {
  const account = await createSyncProject(request);
  await page.goto("/signin");
  await page.getByPlaceholder("Email").fill(account.email);
  await page.getByPlaceholder("Password").fill(account.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  let compilerRequestSeen = false;
  await page.route("**/typst-runtime/**/typst_ts_web_compiler_bg.wasm", async (route) => {
    compilerRequestSeen = true;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.continue();
  });
  await page.goto(`/project/${account.projectId}`);

  await expect(page.locator(".cm-content")).toContainText("SYNC-THIRD");
  await expect(page.locator(".preview-initial-loading")).toBeVisible();
  await expect(page.locator(".preview-loading-copy strong")).toContainText(
    "Preparing Typst compiler"
  );
  await expect(page.locator(".preview-loading-steps .active")).toContainText("Runtime");
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".typst-page").length === 3 &&
      document.querySelectorAll("canvas[data-typst-ready='true']").length === 3,
    null,
    { timeout: 60_000 }
  );
  expect(compilerRequestSeen).toBe(true);
  await expect(page.locator(".preview-initial-loading")).toBeHidden();

  await clickEditorToken(page, "SYNC-THIRD");
  await expect(page.locator(".preview-page-indicator")).toContainText("page 3/3");

  await clickEditorToken(page, "SYNC-SECOND");
  await expect(page.locator(".preview-page-indicator")).toContainText("page 2/3");
  await page.keyboard.press("Control+Home");
  await expect(page.locator(".cm-activeLine")).toContainText("#set page");
  await clickRenderedInk(page, 1);
  await expect(page.locator(".cm-activeLine")).toContainText("SYNC-SECOND");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);

  await clickEditorToken(page, "SYNC-THIRD");
  await expect(page.locator(".preview-page-indicator")).toContainText("page 3/3");
});
