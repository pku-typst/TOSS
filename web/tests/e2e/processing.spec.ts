import { expect, test, type BrowserContext } from "@playwright/test";

const SOURCE = String.raw`\documentclass{article}
\usepackage{amsmath,booktabs,xcolor}
\begin{document}
\section{Background build}
The task center keeps durable work visible across the application.
\[
  \sum_{i=1}^{8} i = 36
\]
\begin{tabular}{lr}
\toprule
State & Attempts \\
\midrule
Succeeded & 1 \\
\bottomrule
\end{tabular}
\end{document}`;

async function signIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post("/v1/auth/local/login", {
    data: { email, password }
  });
  expect(response.ok()).toBeTruthy();
}

test("submits a native LaTeX build and downloads it from the task center", async ({
  page,
  request
}) => {
  test.setTimeout(180_000);
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const email = `processing-ui-${runId}@example.test`;
  const password = "ProcessingUi1234!";
  const projectName = `Processing UI ${runId}`;
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `processing-ui-${runId}`.slice(0, 32),
      display_name: "Processing UI Smoke"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const headers = { authorization: `Bearer ${session.session_token as string}` };
  const capabilitiesResponse = await request.get("/v1/processing/capabilities", { headers });
  expect(capabilitiesResponse.ok()).toBeTruthy();
  const capabilities = await capabilitiesResponse.json();
  const capability = capabilities.capabilities?.find(
    (candidate: { operation?: string }) => candidate.operation === "latex.compile.pdf/v1"
  );
  test.skip(capability?.state !== "available", "a compatible native LaTeX worker is not online");

  const projectResponse = await request.post("/v1/projects", {
    headers,
    data: { name: projectName, project_type: "latex", latex_engine: "pdftex" }
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  const treeResponse = await request.get(`/v1/projects/${project.id}/tree`, { headers });
  expect(treeResponse.ok()).toBeTruthy();
  const tree = await treeResponse.json();
  const updateResponse = await request.put(
    `/v1/projects/${project.id}/documents/by-path/${encodeURIComponent(tree.entry_file_path)}`,
    {
      headers: { ...headers, "x-project-content-epoch": String(tree.content_epoch) },
      data: { content: SOURCE }
    }
  );
  expect(updateResponse.ok()).toBeTruthy();

  await signIn(page.context(), email, password);
  await page.goto(`/project/${project.id}`);
  const buildButton = page.getByRole("button", {
    name: "Build PDF in background",
    exact: true
  });
  await expect(buildButton).toBeEnabled({ timeout: 30_000 });
  await buildButton.click();

  const taskCenter = page.getByRole("dialog", { name: "Tasks", exact: true });
  await expect(taskCenter).toBeVisible();
  const task = taskCenter.locator(".processing-task-item").filter({ hasText: projectName });
  await expect(task).toHaveCount(1);
  await expect(task.getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 120_000 });

  const downloadPromise = page.waitForEvent("download");
  await task.getByRole("button", { name: "main.pdf", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("main.pdf");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright returned no artifact download stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const pdf = Buffer.concat(chunks);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(pdf.subarray(-2048).includes(Buffer.from("%%EOF"))).toBeTruthy();
});
