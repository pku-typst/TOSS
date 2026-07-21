import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createTestProject(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `external-git-ui-${runId}@example.com`;
  const password = "ExternalGitUiTest1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `external-git-ui-${runId}`.slice(0, 32),
      display_name: "External Git UI Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const projectResponse = await request.post("/v1/projects", {
    headers: { authorization: `Bearer ${session.session_token}` },
    data: { name: "Repository-backed Slides" }
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  return { email, password, projectId: project.id as string };
}

async function openProjectStorage(
  page: Page,
  account: { email: string; password: string; projectId: string }
) {
  await page.goto("/signin");
  await page.getByPlaceholder("Email", { exact: true }).fill(account.email);
  await page.getByPlaceholder("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.goto(`/project/${account.projectId}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
}

async function mockExternalGitProvider(page: Page) {
  await page.route("**/v1/auth/config", async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: {
        ...config,
        external_git_providers: [{
          id: "gitlab",
          display_name: "GitLab",
          base_url: "https://git.example.test",
          brand: "gitlab",
          kind: "gitlab",
          authorization_path: "/v1/external-git/providers/gitlab/authorize",
          capabilities: {
            repository_creation: true,
            supported_visibilities: ["private", "public"]
          }
        }]
      }
    });
  });
}

async function mockNoExternalGitProviders(page: Page) {
  await page.route("**/v1/auth/config", async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, external_git_providers: [] }
    });
  });
}

async function mockConfiguredExternalGit(
  page: Page,
  projectId: string,
  statusOverrides: Record<string, unknown> = {}
) {
  await page.route("**/v1/external-git/providers/gitlab/connection", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        bound: true,
        connected: true,
        provider: "gitlab",
        provider_name: "GitLab",
        base_url: "https://git.example.test",
        status: "active",
        account_id: "42",
        username: "owner",
        scopes: ["api"],
        expires_at: null,
        can_disconnect: true,
        disconnect_restriction: null
      })
    })
  );
  await page.route(`**/v1/projects/${projectId}/external-git/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project_id: projectId,
        linked: false,
        provider: "gitlab",
        repository_id: null,
        full_path: null,
        web_url: null,
        default_branch: null,
        checkpoint_branch: null,
        connector_username: "owner",
        workspace_version: 0,
        synced_workspace_version: 0,
        state: "unlinked",
        sync_phase: null,
        next_retry_at: null,
        last_remote_sha: null,
        last_import_branch: null,
        last_import_sha: null,
        last_import_at: null,
        last_import_error: null,
        inbound_job: null,
        last_error: null,
        updated_at: null,
        ...statusOverrides
      })
    })
  );
}

test("shows an explicit workspace-only state when external Git is not configured", async ({
  page,
  request
}, testInfo) => {
  const account = await createTestProject(request);
  await mockNoExternalGitProviders(page);
  await page.route(`**/v1/projects/${account.projectId}/external-git/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project_id: account.projectId,
        linked: false,
        provider: null,
        repository_id: null,
        full_path: null,
        web_url: null,
        default_branch: null,
        checkpoint_branch: null,
        connector_username: null,
        workspace_version: 0,
        synced_workspace_version: 0,
        state: "unlinked",
        sync_phase: null,
        next_retry_at: null,
        last_remote_sha: null,
        last_error: null,
        updated_at: null
      })
    })
  );
  await openProjectStorage(page, account);

  const card = page.locator(".external-git-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".external-git-header-status")).toHaveAttribute("aria-label", /Workspace only/);
  await expect(
    card.getByText("No external Git provider is configured for this deployment.", {
      exact: true
    })
  ).toBeVisible();

  const screenshotPath = testInfo.outputPath("external-git-settings.png");
  await card.screenshot({ path: screenshotPath });
  await testInfo.attach("external-git-settings", {
    path: screenshotPath,
    contentType: "image/png"
  });
  const workspaceScreenshotPath = testInfo.outputPath("workspace-settings.png");
  await page.screenshot({ path: workspaceScreenshotPath, fullPage: true });
  await testInfo.attach("workspace-settings", {
    path: workspaceScreenshotPath,
    contentType: "image/png"
  });
});

test("shows linked repository state and opens branch synchronization", async ({
  page,
  request
}, testInfo) => {
  const account = await createTestProject(request);
  await mockExternalGitProvider(page);
  await mockConfiguredExternalGit(page, account.projectId, {
    linked: true,
    repository_id: "101",
    full_path: "owner/repository-backed-slides",
    web_url: "https://git.example.test/owner/repository-backed-slides",
    default_branch: "main",
    checkpoint_branch: "workspace/main",
    workspace_version: 7,
    synced_workspace_version: 7,
    state: "active",
    last_remote_sha: "abc123",
    last_import_branch: "slides",
    last_import_sha: "def456",
    last_import_at: "2026-07-10T12:00:00Z",
    updated_at: "2026-07-10T12:00:00Z"
  });
  await page.route(
    `**/v1/projects/${account.projectId}/external-git/branches**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          branches: [
            {
              name: "main",
              default: true,
              protected: false,
              commit_sha: "abc123",
              committed_at: null
            },
            {
              name: "slides",
              default: false,
              protected: false,
              commit_sha: "def456",
              committed_at: null
            }
          ],
          next_page: null
        })
      })
  );

  await openProjectStorage(page, account);

  const card = page.locator(".external-git-card");
  await expect(
    card.getByText("owner/repository-backed-slides", { exact: true })
  ).toBeVisible();
  await expect(card.locator(".external-git-header-status")).toHaveAttribute(
    "aria-label",
    /Synced/
  );
  const linkedCardScreenshotPath = testInfo.outputPath(
    "external-git-linked-settings.png"
  );
  await card.screenshot({ path: linkedCardScreenshotPath });
  await testInfo.attach("external-git-linked-settings", {
    path: linkedCardScreenshotPath,
    contentType: "image/png"
  });
  await card.getByRole("button", { name: "Import branch", exact: true }).click();
  const branchSelect = page.getByLabel("Source branch", { exact: true });
  await expect(branchSelect).toBeVisible();
  await expect(branchSelect).toHaveValue("slides");
  await expect(branchSelect.locator("option")).toHaveCount(2);
  const inboundDialogScreenshotPath = testInfo.outputPath(
    "external-git-inbound-dialog.png"
  );
  await page.screenshot({ path: inboundDialogScreenshotPath, fullPage: true });
  await testInfo.attach("external-git-inbound-dialog", {
    path: inboundDialogScreenshotPath,
    contentType: "image/png"
  });
});

test("loads repository creation and connection choices on demand", async ({
  page,
  request
}) => {
  const account = await createTestProject(request);
  await mockExternalGitProvider(page);
  await mockConfiguredExternalGit(page, account.projectId);
  await page.route("**/v1/external-git/providers/gitlab/owners?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        owners: [
          {
            id: "7",
            name: "Owner",
            path: "owner",
            kind: "user",
            full_path: "owner",
            web_url: "https://git.example.test/owner"
          }
        ],
        next_page: null
      })
    })
  );
  await page.route("**/v1/external-git/providers/gitlab/repositories?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        repositories: [
          {
            id: "101",
            name: "existing-slides",
            path: "existing-slides",
            full_path: "owner/existing-slides",
            default_branch: "main",
            visibility: "private",
            web_url: "https://git.example.test/owner/existing-slides",
            archived: false
          }
        ],
        next_page: null
      })
    })
  );

  await openProjectStorage(page, account);

  const card = page.locator(".external-git-card");
  await card
    .getByRole("button", { name: "Create GitLab repository", exact: true })
    .click();
  await expect(card.getByLabel("Repository owner", { exact: true })).toHaveValue("7");
  await expect(card.getByLabel("Repository name", { exact: true })).toHaveValue(
    "Repository-backed Slides"
  );
  await expect(card.getByLabel("Repository path", { exact: true })).toHaveValue(
    "repository-backed-slides"
  );

  await card
    .getByRole("button", { name: "Connect existing repository", exact: true })
    .click();
  await expect(card.getByLabel("GitLab repository", { exact: true })).toHaveValue("101");
  await expect(
    card.locator(".external-git-selected-project strong")
  ).toHaveText("owner/existing-slides");
});
