import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const coreUrl = (process.env.CORE_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const timeoutMilliseconds = Number(process.env.PROCESSING_SMOKE_TIMEOUT_MS ?? 120_000);
const operation = "latex.compile.pdf/v1";
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

async function request(method, path, { token, body, headers, statuses = [200] } = {}) {
  const response = await fetch(new URL(path, `${coreUrl}/`), {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await parseResponse(response);
  if (!statuses.includes(response.status)) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${statuses.join("/")}: ${JSON.stringify(payload)}`
    );
  }
  return { status: response.status, body: payload, headers: response.headers };
}

async function download(path, token) {
  const response = await fetch(new URL(path, `${coreUrl}/`), {
    headers: { authorization: `Bearer ${token}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${bytes.toString("utf8")}`);
  }
  return { bytes, headers: response.headers };
}

async function registerUser() {
  const response = await request("POST", "/v1/auth/local/register", {
    body: {
      email: `latex-worker-${runId}@example.test`,
      password: "LatexWorker1234!",
      username: `latex-worker-${runId}`.slice(0, 32),
      display_name: "LaTeX Worker Smoke"
    },
    statuses: [200, 201]
  });
  assert(typeof response.body?.session_token === "string", "registration returned no session token");
  return response.body.session_token;
}

async function waitForCapability(token) {
  const deadline = Date.now() + timeoutMilliseconds;
  let capability;
  while (Date.now() < deadline) {
    const response = await request("GET", "/v1/processing/capabilities", { token });
    capability = response.body?.capabilities?.find((entry) => entry.operation === operation);
    if (capability?.state === "available") return capability;
    await wait(500);
  }
  throw new Error(`real LaTeX worker did not become available: ${JSON.stringify(capability)}`);
}

async function createProject(token, engine, content) {
  const project = (
    await request("POST", "/v1/projects", {
      token,
      body: {
        name: `Worker smoke ${engine} ${runId}`,
        project_type: "latex",
        latex_engine: engine
      },
      statuses: [200, 201]
    })
  ).body;
  assert(typeof project?.id === "string", `${engine} project creation returned no ID`);

  const [tree, documents] = await Promise.all([
    request("GET", `/v1/projects/${project.id}/tree`, { token }),
    request("GET", `/v1/projects/${project.id}/documents`, { token })
  ]);
  const entryPath = tree.body?.entry_file_path;
  const document = documents.body?.documents?.find((candidate) => candidate.path === entryPath);
  assert(document, `${engine} project has no entry document at ${entryPath}`);

  await request("PUT", `/v1/projects/${project.id}/documents/${document.id}`, {
    token,
    headers: { "x-project-content-epoch": String(tree.body.content_epoch) },
    body: {
      content,
      expected_path_revision: document.path_revision,
      expected_collaboration_revision: document.collaboration_revision
    }
  });
  return project;
}

async function readJob(token, jobId) {
  return (await request("GET", `/v1/processing/jobs/${jobId}`, { token })).body;
}

async function waitForJob(token, jobId) {
  const deadline = Date.now() + timeoutMilliseconds;
  let job = await readJob(token, jobId);
  while (!["succeeded", "failed", "cancelled", "expired"].includes(job.state) && Date.now() < deadline) {
    await wait(300);
    job = await readJob(token, jobId);
  }
  if (job.state !== "succeeded") {
    throw new Error(`job ${jobId} ended in ${job.state}: ${JSON.stringify(job.failure)}`);
  }
  return job;
}

async function submitBuild(token, projectId, idempotencyKey = randomUUID()) {
  return request("POST", `/v1/projects/${projectId}/builds`, {
    token,
    headers: { "idempotency-key": idempotencyKey },
    statuses: [200, 202]
  });
}

async function verifyFreshBuild(token, project, engine) {
  const idempotencyKey = randomUUID();
  const submitted = await submitBuild(token, project.id, idempotencyKey);
  assert(submitted.status === 202, `${engine} build was not admitted asynchronously`);
  const replayed = await submitBuild(token, project.id, idempotencyKey);
  assert(replayed.status === 200, `${engine} idempotency replay did not return an existing job`);
  assert(replayed.body?.id === submitted.body?.id, `${engine} idempotency replay created another job`);

  const job = await waitForJob(token, submitted.body.id);
  assert(job.attempt_count === 1, `${engine} fresh build used ${job.attempt_count} attempts`);
  assert(typeof job.processor_contract === "string", `${engine} job recorded no processor contract`);
  const artifact = job.artifacts.find((candidate) => candidate.role === "pdf");
  assert(artifact, `${engine} job published no PDF artifact`);
  const downloaded = await download(artifact.download_url, token);
  assert(downloaded.bytes.subarray(0, 5).toString("ascii") === "%PDF-", `${engine} artifact is not a PDF`);
  assert(downloaded.bytes.subarray(-2048).includes(Buffer.from("%%EOF")), `${engine} PDF has no EOF marker`);
  assert(downloaded.bytes.length === artifact.size_bytes, `${engine} artifact size changed in transit`);
  assert(sha256(downloaded.bytes) === artifact.sha256, `${engine} artifact digest changed in transit`);
  assert(downloaded.bytes.length > 5_000, `${engine} fixture produced an unexpectedly small PDF`);
  return { job, artifact };
}

async function verifyCacheHit(token, project, source) {
  const submitted = await submitBuild(token, project.id);
  assert(submitted.status === 202, "cache candidate was not admitted as a distinct job");
  const cached = await waitForJob(token, submitted.body.id);
  assert(cached.attempt_count === 0, "exact cache hit consumed a worker attempt");
  const artifact = cached.artifacts.find((candidate) => candidate.role === "pdf");
  assert(artifact, "cache hit published no PDF artifact");
  assert(artifact.sha256 === source.sha256, "cache hit changed the PDF digest");
  const downloaded = await download(artifact.download_url, token);
  assert(sha256(downloaded.bytes) === source.sha256, "cached artifact download changed bytes");
  return cached;
}

const documentBody = String.raw`
\title{Durable LaTeX Worker Validation}
\author{TOSS Community}
\date{2026-07-14}
\maketitle
\tableofcontents

\section{Purpose}\label{sec:purpose}
This fixture exercises native compilation, multiple passes, cross references,
tables, mathematics, vector graphics, hyperlinks, fonts, and artifact transfer.
It is deliberately larger than a one-line smoke document. Section
\ref{sec:results} closes the reference loop.

\section{Model}
For a bounded queue with arrival rate $\lambda$ and service rate $\mu$, define
\[
  \rho = \frac{\lambda}{\mu}, \qquad
  L_q = \frac{\rho^2}{1-\rho}, \qquad 0 \leq \rho < 1.
\]
The normalized objective is
\[
  J(\theta)=\sum_{i=1}^{12}\left(y_i-f_\theta(x_i)\right)^2
    + \alpha\lVert\theta\rVert_2^2.
\]

\section{Measurements}
\begin{longtable}{@{}lrrr@{}}
\toprule
Stage & Input (MiB) & Wall time (s) & Reused \\
\midrule
\endhead
Snapshot & 12.4 & 0.18 & no \\
Transfer & 12.4 & 0.31 & no \\
Compile pass 1 & 12.4 & 1.72 & runtime \\
Compile pass 2 & 12.4 & 0.84 & runtime \\
Publication & 0.42 & 0.09 & blob \\
Authorization & 0.00 & 0.01 & policy \\
\bottomrule
\end{longtable}

\section{Flow}
\begin{center}
\begin{tikzpicture}[node distance=2.4cm,>=stealth]
  \node[draw,rounded corners,fill=blue!10] (snapshot) {Snapshot};
  \node[draw,rounded corners,fill=green!10,right of=snapshot] (claim) {Claim};
  \node[draw,rounded corners,fill=orange!15,right of=claim] (compile) {Compile};
  \node[draw,rounded corners,fill=purple!10,right of=compile] (publish) {Publish};
  \draw[->,thick] (snapshot) -- (claim);
  \draw[->,thick] (claim) -- (compile);
  \draw[->,thick] (compile) -- (publish);
\end{tikzpicture}
\end{center}

\section{Results}\label{sec:results}
The durable result belongs to the job aggregate while the immutable bytes are
content addressed. A cache hit creates a new authorized job and does not reuse
another user's authorization. See \href{https://typst.app/}{Typst} for the
interactive authoring model that remains independent of this background path.

\subsection{Repeated content}
The following paragraph is repeated to force realistic line breaking and font
loading. Deterministic inputs, an immutable runtime, bounded execution, and an
explicit processor contract make the result explainable without putting native
compilation on the editor's latency-critical path.

Deterministic inputs, an immutable runtime, bounded execution, and an explicit
processor contract make the result explainable without putting native
compilation on the editor's latency-critical path. Durable jobs preserve state,
failure evidence, provenance, and downloadable artifacts across browser sessions.
`;

export const pdftexDocument = String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,microtype}
\usepackage{amsmath,amssymb,booktabs,longtable,xcolor,tikz,hyperref}
\hypersetup{colorlinks=true,linkcolor=blue,urlcolor=purple}
\begin{document}
${documentBody}
\end{document}
`;

export const xetexDocument = String.raw`\documentclass[11pt]{article}
\usepackage{fontspec}
\setmainfont{Latin Modern Roman}
\usepackage{microtype,amsmath,amssymb,booktabs,longtable,xcolor,tikz,hyperref}
\hypersetup{colorlinks=true,linkcolor=blue,urlcolor=purple}
\begin{document}
${documentBody}
\paragraph{Unicode probe} XeLaTeX shapes naïve café, Ελληνικά, and Привет directly.
\end{document}
`;

async function main() {
  assert(Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0, "invalid smoke timeout");
  const token = await registerUser();
  const capability = await waitForCapability(token);
  const pdftexProject = await createProject(token, "pdftex", pdftexDocument);
  const xetexProject = await createProject(token, "xetex", xetexDocument);

  const pdftex = await verifyFreshBuild(token, pdftexProject, "pdfLaTeX");
  const xetex = await verifyFreshBuild(token, xetexProject, "XeLaTeX");
  const cached = await verifyCacheHit(token, pdftexProject, pdftex.artifact);

  console.log(
    JSON.stringify(
      {
        core_url: coreUrl,
        capability_state: capability.state,
        processor_contract: pdftex.job.processor_contract,
        pdftex: { job_id: pdftex.job.id, bytes: pdftex.artifact.size_bytes },
        xetex: { job_id: xetex.job.id, bytes: xetex.artifact.size_bytes },
        cache: { job_id: cached.id, attempt_count: cached.attempt_count }
      },
      null,
      2
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
