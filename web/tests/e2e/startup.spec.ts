import { expect, test, type APIRequestContext } from "@playwright/test";

async function createHomeAccount(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `home-startup-${runId}@example.com`;
  const password = "HomeStartup1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `home-startup-${runId}`.slice(0, 32),
      display_name: "Home Startup Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const projectResponse = await request.post("/v1/projects", {
    headers: { authorization: `Bearer ${session.session_token}` },
    data: { name: `Home Startup ${runId}` }
  });
  expect(projectResponse.ok()).toBeTruthy();
  return { email, password };
}

test("renders a static product skeleton before JavaScript starts", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });

  expect(response?.ok()).toBeTruthy();
  const productBoot = page.locator(".app-static-boot.app-boot--product");
  await expect(productBoot).toBeVisible();
  await expect(productBoot.locator(".app-boot__bar")).toBeVisible();
  await expect(productBoot.locator(".app-boot__product")).toBeVisible();
  await expect(productBoot.locator(".app-boot__product-window")).toBeVisible();
  await expect(page.locator(".app-static-boot.app-boot--workspace")).toBeHidden();

  const bootColors = await page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-boot-accent")
      .trim();
    const accentProbe = document.createElement("span");
    const brandProbe = document.createElement("span");
    accentProbe.style.color = accent;
    brandProbe.style.color = "var(--toss-brand-accent)";
    document.body.append(accentProbe, brandProbe);
    const expected = getComputedStyle(accentProbe).color;
    const brand = getComputedStyle(brandProbe).color;
    accentProbe.remove();
    brandProbe.remove();
    return {
      expected,
      brand,
      mark: getComputedStyle(
        document.querySelector(".app-static-boot.app-boot--product .app-boot__mark") as Element
      ).backgroundColor
    };
  });
  expect(bootColors.mark).toBe(bootColors.expected);
  expect(bootColors.brand).toBe(bootColors.expected);

  const viewportCoverage = await productBoot.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      widthRatio: rect.width / window.innerWidth,
      heightRatio: rect.height / window.innerHeight
    };
  });
  expect(viewportCoverage.widthRatio).toBeGreaterThan(0.98);
  expect(viewportCoverage.heightRatio).toBeGreaterThan(0.98);
  await context.close();
});

test("selects the editor skeleton before the application bundle loads", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/\/assets\/.*\.js(?:\?.*)?$/, (route) => route.abort());

  const response = await page.goto("/project/00000000-0000-4000-8000-000000000000", {
    waitUntil: "domcontentloaded"
  });

  expect(response?.ok()).toBeTruthy();
  const workspaceBoot = page.locator(".app-static-boot.app-boot--workspace");
  await expect(workspaceBoot).toBeVisible();
  await expect(workspaceBoot.locator(".app-boot__panel")).toHaveCount(3);
  await expect(page.locator(".app-static-boot.app-boot--product")).toBeHidden();
  await context.close();
});

test("uses the editor skeleton only while a workspace route is starting", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let releaseAuthConfig = () => undefined;
  const authConfigGate = new Promise<void>((resolve) => {
    releaseAuthConfig = resolve;
  });
  await page.route("**/v1/auth/config", async (route) => {
    await authConfigGate;
    await route.continue();
  });

  await page.goto("/project/00000000-0000-4000-8000-000000000000", {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator(".app-boot--workspace")).toBeVisible();
  await expect(page.locator(".app-boot--workspace .app-boot__panel")).toHaveCount(3);
  releaseAuthConfig();
  await expect(page).toHaveURL(/\/signin\?returnTo=/);
  await context.close();
});

test("keeps the project home independent from editor and Typst runtime downloads", async ({
  page,
  request
}) => {
  const account = await createHomeAccount(request);
  const startupRequests: string[] = [];
  const scriptResponses: Array<{ url: string; encoding: string }> = [];
  page.on("request", (browserRequest) => startupRequests.push(browserRequest.url()));
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") {
      scriptResponses.push({
        url: response.url(),
        encoding: response.headers()["content-encoding"] ?? "identity"
      });
    }
  });

  await page.goto("/signin");
  await page.getByPlaceholder("Email").fill(account.email);
  await page.getByPlaceholder("Password").fill(account.password);
  await page.getByPlaceholder("Password").press("Enter");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.waitForTimeout(750);

  expect(startupRequests.some((url) => url.includes("/typst-runtime/"))).toBe(false);
  expect(startupRequests.some((url) => /\/assets\/vendor-collab-typst-[^/]+\.js/.test(url))).toBe(false);
  expect(startupRequests.some((url) => /\/assets\/vendor-editor-[^/]+\.js/.test(url))).toBe(false);
  expect(startupRequests.some((url) => /\/assets\/typst\.worker-[^/]+\.js/.test(url))).toBe(false);
  const largeStartupScripts = scriptResponses.filter(({ url }) =>
    /\/assets\/(?:index|api|vendor-react)-[^/]+\.js/.test(url)
  );
  expect(largeStartupScripts.length).toBeGreaterThanOrEqual(3);
  expect(largeStartupScripts.every(({ encoding }) => encoding === "gzip")).toBe(true);
});
