import { expect, test, type APIRequestContext } from "@playwright/test";

async function createGalleryAccount(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `gallery-${runId}@example.com`;
  const password = "GalleryTest1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `gallery-${runId}`.slice(0, 32),
      display_name: "Gallery Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  return {
    email,
    password,
    headers: { authorization: `Bearer ${session.session_token}` }
  };
}

test("creates independent projects and manages personal templates from the Gallery", async ({
  page,
  request
}) => {
  const account = await createGalleryAccount(request);
  const catalogResponse = await request.get("/v1/templates", { headers: account.headers });
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const builtin = catalog.templates.find((template: { source: string }) => template.source === "builtin");
  expect(builtin).toBeTruthy();
  expect(builtin.name.en).toBeTruthy();
  expect(builtin.name["zh-CN"]).toBeTruthy();

  const thumbnailResponse = await request.get(
    `/v1/templates/builtin/${encodeURIComponent(builtin.id)}/thumbnail`,
    { headers: account.headers }
  );
  expect(thumbnailResponse.ok()).toBeTruthy();
  expect(thumbnailResponse.headers()["content-type"]).toMatch(/^image\//);

  await page.goto("/signin");
  await page.getByPlaceholder("Email", { exact: true }).fill(account.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(account.password);
  await page.getByPlaceholder("Password", { exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  let galleryRequests = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/v1/templates") galleryRequests += 1;
  });
  await page.getByRole("link", { name: "Gallery", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Template Gallery", exact: true })
  ).toBeVisible();
  await expect(page.locator(".gallery-card").first()).toBeVisible();
  expect(galleryRequests).toBe(1);

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Gallery", exact: true }).click();
  const firstCard = page.locator(".gallery-card").first();
  await expect(firstCard).toBeVisible();
  await page.waitForTimeout(200);
  expect(galleryRequests).toBe(1);
  await expect(firstCard.locator(".gallery-thumbnail")).toBeVisible();

  const projectName = `Gallery Project ${Date.now()}`;
  await firstCard.getByRole("button", { name: "Use template", exact: true }).click();
  const createDialog = page.getByRole("dialog", {
    name: "Create from template",
    exact: true
  });
  await createDialog.getByRole("textbox").fill(projectName);
  await createDialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page).toHaveURL(/\/project\/[0-9a-f-]+$/);
  const projectId = page.url().split("/").pop();
  expect(projectId).toBeTruthy();

  const projectTitle = page.getByRole("button", { name: `Rename: ${projectName}`, exact: true });
  await expect(projectTitle).toBeVisible();
  await projectTitle.click();
  const projectTitleInput = page.getByRole("textbox", { name: "Rename", exact: true });
  await projectTitleInput.fill(`${projectName} discarded`);
  await projectTitleInput.press("Escape");
  await expect(projectTitle).toBeVisible();

  const renamedProjectName = `${projectName} Renamed`;
  await projectTitle.click();
  await projectTitleInput.fill(renamedProjectName);
  await projectTitleInput.press("Enter");
  await expect(page.getByRole("button", { name: `Rename: ${renamedProjectName}`, exact: true })).toBeVisible();

  const treeResponse = await request.get(`/v1/projects/${projectId}/tree`, {
    headers: account.headers
  });
  expect(treeResponse.ok()).toBeTruthy();
  const tree = await treeResponse.json();
  expect(tree.entry_file_path).toMatch(/\.(typ|tex)$/);
  expect(tree.nodes).toContainEqual({ path: tree.entry_file_path, kind: "file" });

  await page.goto("/gallery");
  await page
    .getByRole("button", { name: "Create personal template", exact: true })
    .click();
  const personalDialog = page.getByRole("dialog", {
    name: "Add a personal template",
    exact: true
  });
  await expect(personalDialog.getByRole("combobox")).toHaveValue(projectId ?? "");
  await personalDialog.getByRole("button", { name: "Add to Gallery", exact: true }).click();
  await page.getByRole("button", { name: "My templates", exact: true }).click();
  const personalCard = page.locator(".gallery-card", { hasText: renamedProjectName });
  await expect(personalCard).toBeVisible();
  await personalCard
    .getByRole("button", { name: "Remove from Gallery", exact: true })
    .click();
  const removeDialog = page.getByRole("dialog", {
    name: "Remove personal template?",
    exact: true
  });
  await removeDialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(personalCard).toHaveCount(0);

  const projectsResponse = await request.get("/v1/projects", { headers: account.headers });
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json();
  expect(
    projects.projects.some(
      (project: { id: string; is_template: boolean }) =>
        project.id === projectId && project.is_template === false
    )
  ).toBe(true);
});
