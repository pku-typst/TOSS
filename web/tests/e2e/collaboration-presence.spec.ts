import { expect, test, type APIRequestContext } from "@playwright/test";

async function createPresenceProject(request: APIRequestContext) {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const email = `presence-${runId}@example.com`;
  const password = "Presence1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `presence-${runId}`.slice(0, 32),
      display_name: "Presence Tester",
    },
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const projectResponse = await request.post("/v1/projects", {
    headers: { authorization: `Bearer ${session.session_token}` },
    data: { name: `Presence ${runId}` },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  return { email, password, projectId: project.id as string };
}

test("shows multiple editing sessions for one account without double-counting collaborators", async ({
  context,
  page,
  request,
}) => {
  const account = await createPresenceProject(request);
  await page.goto("/signin");
  await page.getByPlaceholder("Email", { exact: true }).fill(account.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(account.password);
  await page.locator(".auth-submit").click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();

  await page.goto(`/project/${account.projectId}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".editor-peer-count")).toContainText("1");
  await expect(page.locator(".editor-session-count")).toHaveCount(0);

  const secondPage = await context.newPage();
  await secondPage.goto(`/project/${account.projectId}`);
  await expect(secondPage.locator(".cm-content")).toBeVisible();

  await expect(page.locator(".editor-peer-count")).toContainText("1");
  await expect(secondPage.locator(".editor-peer-count")).toContainText("1");
  await expect(page.locator(".editor-session-count")).toContainText("2");
  await expect(secondPage.locator(".editor-session-count")).toContainText("2");
  await expect(page.locator(".editor-session-count")).toHaveAttribute(
    "title",
    "2 active editing sessions",
  );

  await secondPage.locator(".cm-content").click();
  await secondPage.keyboard.press("End");
  await expect(page.locator(".remote-cursor-label")).toHaveText(
    "Presence Tester",
  );
  await expect(secondPage.locator(".remote-cursor")).toHaveCount(0);

  await secondPage.close();
  await expect(page.locator(".editor-session-count")).toHaveCount(0);
});
