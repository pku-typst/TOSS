import { expect, test, type APIRequestContext } from "@playwright/test";

async function createProductShellAccount(request: APIRequestContext) {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const email = `product-shell-${runId}@example.com`;
  const password = "ProductShell1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `product-shell-${runId}`.slice(0, 32),
      display_name: "Product Shell Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  return { email, password };
}

test("provides a branded public entry point, help, and explicit route states", async ({
  page,
  request
}) => {
  const experienceResponse = await request.get("/v1/experience");
  expect(experienceResponse.ok()).toBeTruthy();
  expect(experienceResponse.headers()["cache-control"]).toContain("private");
  expect(experienceResponse.headers()["cache-control"]).toContain("no-store");
  expect(experienceResponse.headers().vary).toContain("cookie");
  expect(experienceResponse.headers().vary).toContain("authorization");
  const experience = await experienceResponse.json();
  const publicResourceIds = experience.resources.map((resource: { id: string }) => resource.id);

  const faviconResponse = await request.get("/favicon.ico");
  expect(faviconResponse.ok()).toBeTruthy();
  expect(faviconResponse.headers()["content-type"]).toBe("image/svg+xml");
  expect((await faviconResponse.text()).trimStart()).toMatch(/^<svg\b/);

  await page.goto("/");
  await expect(page).toHaveTitle(experience.product.name);
  await expect(
    page.getByRole("heading", { name: experience.landing.headline.en, exact: true })
  ).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/v1/product-assets/favicon"
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    experience.product.accent_color
  );

  await page.setViewportSize({ width: 320, height: 568 });
  await expect(
    page.getByRole("button", { name: "Open navigation menu", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
  await expect(page.locator(".app-navigation-menu nve-menu-item").first()).toBeVisible();
  const mobileHomeLayout = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const hero = document.querySelector(".home-hero") as HTMLElement;
    const copy = document.querySelector(".home-hero-copy") as HTMLElement;
    const contained = [
      hero,
      copy,
      document.querySelector(".home-product-visual") as HTMLElement,
      ...Array.from(document.querySelectorAll<HTMLElement>(".home-hero-actions nve-button"))
    ].map((node) => node.getBoundingClientRect());
    return {
      viewportWidth,
      horizontalOverflow: document.documentElement.scrollWidth - viewportWidth,
      heroColumns: getComputedStyle(hero).gridTemplateColumns.trim().split(/\s+/).length,
      copyWidth: copy.getBoundingClientRect().width,
      heroWidth: hero.getBoundingClientRect().width,
      outOfBoundsCount: contained.filter(
        (bounds) => bounds.left < -0.5 || bounds.right > viewportWidth + 0.5
      ).length,
      actionHeights: Array.from(
        document.querySelectorAll<HTMLElement>(".home-hero-actions nve-button")
      ).map((node) => node.getBoundingClientRect().height),
      menuItemHeights: Array.from(
        document.querySelectorAll<HTMLElement>(".app-navigation-menu nve-menu-item")
      ).map((node) => node.getBoundingClientRect().height)
    };
  });
  expect(mobileHomeLayout.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(mobileHomeLayout.heroColumns).toBe(1);
  expect(mobileHomeLayout.copyWidth).toBeGreaterThanOrEqual(mobileHomeLayout.heroWidth - 1);
  expect(mobileHomeLayout.outOfBoundsCount).toBe(0);
  expect(mobileHomeLayout.actionHeights).toHaveLength(2);
  expect(Math.min(...mobileHomeLayout.actionHeights)).toBeGreaterThanOrEqual(43);
  expect(Math.min(...mobileHomeLayout.menuItemHeights)).toBeGreaterThanOrEqual(43);
  await page.evaluate(() => document.getElementById("app-navigation-menu")?.hidePopover());
  await page.locator(".home-hero-actions nve-button").last().click({ trial: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  let helpRequestCount = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/v1/help") helpRequestCount += 1;
  });
  await page.goto("/help");
  await expect(page.getByRole("heading", { name: "Help Center", exact: true })).toBeVisible();
  await expect(page).toHaveTitle(`Help Center · ${experience.product.name}`);
  expect(helpRequestCount).toBe(1);
  const publicHelpResponse = await request.get("/v1/help");
  expect(publicHelpResponse.ok()).toBeTruthy();
  expect(publicHelpResponse.headers()["cache-control"]).toContain("private");
  expect(publicHelpResponse.headers()["cache-control"]).toContain("no-store");
  expect(publicHelpResponse.headers().vary).toContain("cookie");
  expect(publicHelpResponse.headers().vary).toContain("authorization");
  const publicHelp = await publicHelpResponse.json();
  expect(publicHelp.topics.length).toBeGreaterThan(0);

  await page.setViewportSize({ width: 320, height: 568 });
  const mobileTopicPicker = page.locator(".help-topic-picker select");
  await expect(mobileTopicPicker).toBeVisible();
  await expect(page.locator(".help-topic-nav")).toBeHidden();
  const pickerHeight = await mobileTopicPicker.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  expect(pickerHeight).toBeGreaterThanOrEqual(43);
  if (publicHelp.topics.length > 1) {
    await mobileTopicPicker.selectOption(publicHelp.topics[1].id);
    await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get("topic"))).toBe(
      publicHelp.topics[1].id
    );
  }
  const mobileArticleBounds = await page.locator(".help-article").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, viewportWidth: document.documentElement.clientWidth };
  });
  expect(mobileArticleBounds.left).toBeGreaterThanOrEqual(-0.5);
  expect(mobileArticleBounds.right).toBeLessThanOrEqual(mobileArticleBounds.viewportWidth + 0.5);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const pageContent = page.locator(".app-content.page-content");
  await pageContent.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Help Center", exact: true })).toBeVisible();
  await expect.poll(() => pageContent.evaluate((element) => element.scrollTop)).toBe(0);
  expect(helpRequestCount).toBe(1);

  await page.goto("/route-that-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/route-that-does-not-exist$/);

  const account = await createProductShellAccount(request);
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fprofile$/);
  await page.getByPlaceholder("Email", { exact: true }).fill(account.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(account.password);
  await page.getByPlaceholder("Password", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { name: "Profile Security", exact: true })).toBeVisible();

  const authenticatedExperienceResponse = await page.context().request.get("/v1/experience");
  expect(authenticatedExperienceResponse.ok()).toBeTruthy();
  const authenticatedExperience = await authenticatedExperienceResponse.json();
  const authenticatedResourceIds = authenticatedExperience.resources.map(
    (resource: { id: string }) => resource.id
  );
  expect(authenticatedResourceIds).toEqual(expect.arrayContaining(publicResourceIds));

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Access denied", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto("/project/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Project unavailable", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/project\/00000000-0000-4000-8000-000000000000$/);
});
