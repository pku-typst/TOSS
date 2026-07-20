import { expect, test, type APIRequestContext } from "@playwright/test";

async function createLocalizedTestProject(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `i18n-${runId}@example.com`;
  const password = "I18nTest1234!";
  const username = `i18n${runId}`.slice(0, 32);
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username,
      display_name: "I18n Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const registrationPayload = await registration.json();
  const headers = { authorization: `Bearer ${registrationPayload.session_token}` };
  const projectResponse = await request.post("/v1/projects", {
    headers,
    data: { name: `I18n Project ${runId}` }
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  const documentResponse = await request.put(
    `/v1/projects/${project.id}/documents/by-path/${encodeURIComponent("main.typ")}`,
    {
      headers,
      data: {
        content: [
          "#set page(width: 16cm, height: 9cm)",
          "= Page One",
          "#pagebreak()",
          "= Page Two",
          "#pagebreak()",
          "= Page Three"
        ].join("\n")
      }
    }
  );
  expect(documentResponse.ok()).toBeTruthy();
  return { email, password, projectId: project.id };
}

test("switches, persists, and applies Chinese throughout the main workflow", async ({ page, request }, testInfo) => {
  const account = await createLocalizedTestProject(request);
  await page.goto("/signin");

  const signInHeading = page.locator("main h1");
  const englishHeading = await signInHeading.textContent();
  const language = page.locator('select[aria-label="Language"]');
  await language.selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(signInHeading).not.toHaveText(englishHeading ?? "");
  const chineseHeading = await signInHeading.textContent();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(signInHeading).toHaveText(chineseHeading ?? "");
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator(".projects-create-card")).toBeVisible();

  await page.goto(`/project/${account.projectId}`);
  await expect(page.locator(".workspace-shell")).toBeVisible();
  await expect(page.locator(".panel-files")).toBeVisible();
  await expect(page.locator(".panel-preview")).toBeVisible();
  await expect(page.locator(".tree-node nve-icon-button").first()).toBeVisible();
  await page.waitForFunction(
    () => document.querySelectorAll(".pdf-frame .typst-page").length === 3,
    null,
    { timeout: 60_000 }
  );
  await expect(page.locator(".preview-page-indicator")).toBeVisible();

  await page.locator('[data-panel-toggle="settings"]:visible').click();
  await expect(page.locator(".panel-settings")).toBeVisible();
  await page.locator("#settings-tab-access").click();
  await expect(page.locator("#settings-panel-access")).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => document.fonts.check('12px "Noto Sans SC Variable"', "中文"))
  ).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  const screenshotPath = testInfo.outputPath("workspace-zh-CN.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("workspace-zh-CN", {
    path: screenshotPath,
    contentType: "image/png"
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".workspace-view-menu-wrap nve-button").click();
  const englishMenuItem = page.locator('nve-menu-item[role="menuitemradio"]').first();
  await expect(englishMenuItem).toBeVisible();
  await englishMenuItem.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.setViewportSize({ width: 1620, height: 1020 });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".panel-files")).toBeVisible();
});
