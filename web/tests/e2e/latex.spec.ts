import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { isLatexGeneratedAuxiliaryPath } from "../../src/lib/latexRuntimeUtils";

type LatexEngine = "xetex" | "pdftex";

const REFERENCE_SOURCE = String.raw`\documentclass{article}
\usepackage{xcolor}
\begin{document}
\section{First section}\label{sec:first}
See Section~\ref{sec:first}. \textcolor{blue}{The package resolver is ready.}
\end{document}`;

const TWO_PAGE_SOURCE = String.raw`\documentclass{article}
\begin{document}
First page after a live edit.
\newpage
Second page after a live edit.
\end{document}`;

async function createLatexProjects(request: APIRequestContext) {
  const runId = Date.now().toString();
  const email = `latex-${runId}@example.com`;
  const password = "LatexRuntime1234!";
  const registration = await request.post("/v1/auth/local/register", {
    data: {
      email,
      password,
      username: `latex-${runId}`.slice(0, 32),
      display_name: "LaTeX Runtime Tester"
    }
  });
  expect(registration.ok()).toBeTruthy();
  const session = await registration.json();
  const headers = { authorization: `Bearer ${session.session_token}` };
  const projects = new Map<LatexEngine, string>();
  for (const engine of ["xetex", "pdftex"] as const) {
    const response = await request.post("/v1/projects", {
      headers,
      data: {
        name: `LaTeX ${engine} ${runId}`,
        project_type: "latex",
        latex_engine: engine
      }
    });
    expect(response.ok()).toBeTruthy();
    const project = await response.json();
    const treeResponse = await request.get(`/v1/projects/${project.id}/tree`, { headers });
    expect(treeResponse.ok()).toBeTruthy();
    const tree = await treeResponse.json();
    const documentResponse = await request.put(
      `/v1/projects/${project.id}/documents/by-path/${encodeURIComponent("main.tex")}`,
      {
        headers: {
          ...headers,
          "x-project-content-epoch": String(tree.content_epoch)
        },
        data: { content: REFERENCE_SOURCE }
      }
    );
    expect(documentResponse.ok()).toBeTruthy();
    projects.set(engine, project.id as string);
  }
  return { email, password, projects };
}

async function signIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post("/v1/auth/local/login", {
    data: { email, password }
  });
  expect(response.ok()).toBeTruthy();
}

async function expectLatexPreview(page: Page, projectId: string) {
  const unexpectedResponses: Array<{ status: number; path: string }> = [];
  const trackResponse = (response: { status(): number; url(): string }) => {
    if (!response.url().includes("/v1/latex/texlive/")) return;
    const status = response.status();
    const path = new URL(response.url()).pathname;
    const leakedGeneratedFile = status === 404 && isLatexGeneratedAuxiliaryPath(path);
    // A TeX Live 404 is the file-miss protocol used for optional configs and
    // font fallbacks. Required misses fail the compile below. Generated aux
    // files are different: the frontend must suppress those requests entirely.
    if ((status >= 400 && status !== 404) || leakedGeneratedFile) {
      unexpectedResponses.push({ status, path });
    }
  };
  page.on("response", trackResponse);
  await page.goto(`/project/${projectId}`);
  const canvas = page.locator(".pdf-pages canvas").first();
  const diagnostic = page.locator(".compile-error-alert, .diagnostic-item").first();
  await Promise.race([
    canvas.waitFor({ state: "visible", timeout: 180_000 }),
    diagnostic.waitFor({ state: "visible", timeout: 180_000 }).then(async () => {
      throw new Error(`LaTeX preview failed: ${(await diagnostic.textContent())?.trim() ?? "unknown"}`);
    })
  ]);
  await expect(page.locator(".compile-error-alert, .diagnostic-item")).toHaveCount(0);
  expect(unexpectedResponses).toEqual([]);
  page.off("response", trackResponse);
}

test("renders packages, references, and live edits with XeTeX and pdfTeX", async ({
  page,
  request
}) => {
  test.setTimeout(240_000);
  const configResponse = await request.get("/v1/auth/config");
  expect(configResponse.ok()).toBeTruthy();
  const config = await configResponse.json();
  test.skip(
    !Array.isArray(config.enabled_project_types) ||
      !config.enabled_project_types.includes("latex"),
    "LaTeX is disabled in this distribution"
  );

  const account = await createLatexProjects(request);
  await signIn(page.context(), account.email, account.password);
  const xetexProject = account.projects.get("xetex");
  const pdftexProject = account.projects.get("pdftex");
  expect(xetexProject).toBeTruthy();
  expect(pdftexProject).toBeTruthy();
  if (!xetexProject || !pdftexProject) return;

  await expectLatexPreview(page, xetexProject);
  await page.locator(".cm-content[contenteditable='true']").fill(TWO_PAGE_SOURCE);
  await expect(page.locator(".pdf-pages canvas")).toHaveCount(2, { timeout: 180_000 });
  await expect(page.locator(".compile-error-alert, .diagnostic-item")).toHaveCount(0);
  await expectLatexPreview(page, pdftexProject);
});
