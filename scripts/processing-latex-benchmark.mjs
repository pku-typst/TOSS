import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import {
  pdftexDocument,
  xetexDocument
} from "./processing-latex-worker-smoke.mjs";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const coreUrl = (process.env.CORE_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const workerContainer =
  process.env.LATEX_WORKER_CONTAINER ?? "toss-latex-worker-1";
const runs = Number(process.env.LATEX_BENCHMARK_RUNS ?? 5);
const coldRuns = Number(process.env.LATEX_BENCHMARK_COLD_RUNS ?? 3);
const timeoutMilliseconds = Number(process.env.LATEX_BENCHMARK_TIMEOUT_MS ?? 240_000);
const selectedEngines = (process.env.LATEX_BENCHMARK_ENGINES ?? "pdftex,xetex")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const operation = "latex.compile.pdf/v1";
const startedAt = new Date();
const runId = String(Date.now()) + "-" + randomUUID().slice(0, 8);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values, fraction) {
  assert(values.length > 0, "cannot summarize an empty sample");
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function summarize(values) {
  return {
    count: values.length,
    min_ms: Math.min(...values),
    median_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: Math.max(...values),
    mean_ms: values.reduce((total, value) => total + value, 0) / values.length
  };
}

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  }
  return typeof value === "number" ? Math.round(value * 10) / 10 : value;
}

function sourceFor(engine, marker) {
  const source = engine === "xetex" ? xetexDocument : pdftexDocument;
  let expansion = "\n\\section{Generated benchmark corpus}\n";
  for (let index = 1; index <= 36; index += 1) {
    expansion +=
      "\\subsection{Workload block " +
      index +
      "}\\label{bench:block-" +
      index +
      "}\n" +
      "This synthetic public fixture exercises paragraph shaping, hyphenation, " +
      "cross references, mathematics, and page breaking. It deliberately repeats " +
      "enough structured material to make compiler work visible beyond startup cost. " +
      "Section~\\ref{sec:purpose} defines the purpose and block " +
      index +
      " contributes to the final artifact.\n\n" +
      "\\begin{align}\n" +
      "  S_{" +
      index +
      "} &= \\sum_{k=1}^{64} \\frac{k^2 + " +
      index +
      "}{k + 1}, \\\\\n" +
      "  Q_{" +
      index +
      "}(x) &= \\prod_{j=1}^{8}\\left(x + \\frac{j}{" +
      (index + 1) +
      "}\\right).\n" +
      "\\end{align}\n\n";
  }
  const expanded = source.replace("\\end{document}", expansion + "\\end{document}");
  return "% TOSS benchmark marker: " + marker + "\n" + expanded;
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

async function request(method, path, { token, body, headers, statuses = [200] } = {}) {
  const response = await fetch(new URL(path, coreUrl + "/"), {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(headers ?? {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await parseResponse(response);
  if (!statuses.includes(response.status)) {
    throw new Error(
      method +
        " " +
        path +
        " returned " +
        response.status +
        ", expected " +
        statuses.join("/") +
        ": " +
        JSON.stringify(payload)
    );
  }
  return { status: response.status, body: payload };
}

async function registerUser() {
  const email = "latex-benchmark-" + runId + "@example.test";
  const password = "LatexBenchmark1234!";
  const response = await request("POST", "/v1/auth/local/register", {
    body: {
      email,
      password,
      username: ("latex-benchmark-" + runId).slice(0, 32),
      display_name: "LaTeX Benchmark"
    },
    statuses: [200, 201]
  });
  assert(typeof response.body?.session_token === "string", "registration returned no token");
  return { email, password, token: response.body.session_token };
}

async function createProject(token, engine, name, content) {
  const response = await request("POST", "/v1/projects", {
    token,
    body: {
      name,
      project_type: "latex",
      latex_engine: engine
    },
    statuses: [200, 201]
  });
  assert(typeof response.body?.id === "string", "project creation returned no ID");
  await updateProject(token, response.body.id, content);
  return response.body;
}

async function updateProject(token, projectId, content) {
  const tree = (await request("GET", "/v1/projects/" + projectId + "/tree", { token })).body;
  await request(
    "PUT",
    "/v1/projects/" + projectId + "/documents/by-path/" + encodeURIComponent("main.tex"),
    {
      token,
      headers: { "x-project-content-epoch": String(tree.content_epoch) },
      body: { content }
    }
  );
}

async function waitForCapability(token) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastCapability;
  while (Date.now() < deadline) {
    const body = (await request("GET", "/v1/processing/capabilities", { token })).body;
    lastCapability = body?.capabilities?.find((entry) => entry.operation === operation);
    if (lastCapability?.state === "available") return lastCapability;
    await wait(250);
  }
  throw new Error("worker did not become available: " + JSON.stringify(lastCapability));
}

async function submitBuild(token, projectId) {
  return request("POST", "/v1/projects/" + projectId + "/builds", {
    token,
    headers: { "idempotency-key": randomUUID() },
    statuses: [200, 202]
  });
}

async function waitForJob(token, jobId) {
  const deadline = Date.now() + timeoutMilliseconds;
  let job;
  while (Date.now() < deadline) {
    job = (await request("GET", "/v1/processing/jobs/" + jobId, { token })).body;
    if (["succeeded", "failed", "cancelled", "expired"].includes(job.state)) break;
    await wait(25);
  }
  assert(job?.state === "succeeded", "job did not succeed: " + JSON.stringify(job));
  return job;
}

function installBrowserProbe() {
  const resources = () => {
    const entries = performance
      .getEntriesByType("resource")
      .filter((entry) => /\/busytex\/|\/v1\/latex\/texlive\//.test(entry.name));
    return {
      count: entries.length,
      transfer_bytes: entries.reduce((total, entry) => total + (entry.transferSize || 0), 0)
    };
  };
  const state = { results: [] };
  Object.defineProperty(window, "__tossLatexBenchmark", {
    value: state,
    configurable: false
  });
  const NativeWorker = window.Worker;
  class InstrumentedWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.__latexStarts = new Map();
      this.addEventListener("message", (event) => {
        const message = event.data;
        if (
          !message ||
          typeof message.id !== "number" ||
          typeof message.ok !== "boolean" ||
          !this.__latexStarts.has(message.id)
        ) {
          return;
        }
        const start = this.__latexStarts.get(message.id);
        this.__latexStarts.delete(message.id);
        const endResources = resources();
        state.results.push({
          id: message.id,
          marker: start.marker,
          ok: message.ok,
          errors: message.errors ?? [],
          worker_wall_ms: performance.now() - start.started_ms,
          navigation_to_result_ms: performance.now(),
          runtime_request_count: endResources.count - start.resources.count,
          runtime_transfer_bytes:
            endResources.transfer_bytes - start.resources.transfer_bytes,
          pdf_bytes: message.pdfBytes?.byteLength ?? 0,
          window_heap_bytes: performance.memory?.usedJSHeapSize ?? null
        });
      });
    }

    postMessage(message, transfer) {
      if (
        message &&
        typeof message.id === "number" &&
        (message.engine === "pdftex" || message.engine === "xetex") &&
        Array.isArray(message.documents)
      ) {
        const source = message.documents
          .map((document) => document.content)
          .join("\n");
        const marker = /^% TOSS benchmark marker: ([^\r\n]+)/m.exec(source)?.[1] ?? "unknown";
        this.__latexStarts.set(message.id, {
          marker,
          started_ms: performance.now(),
          resources: resources()
        });
      }
      if (transfer === undefined) return super.postMessage(message);
      return super.postMessage(message, transfer);
    }
  }
  Object.defineProperty(window, "Worker", {
    value: InstrumentedWorker,
    configurable: true,
    writable: true
  });
}

async function signInBrowser(context, account) {
  const response = await context.request.post(coreUrl + "/v1/auth/local/login", {
    data: { email: account.email, password: account.password }
  });
  assert(response.ok(), "browser login failed: " + response.status());
}

async function browserResult(page, marker) {
  await page.waitForFunction(
    (expectedMarker) =>
      window.__tossLatexBenchmark?.results.some((result) => result.marker === expectedMarker),
    marker,
    { timeout: timeoutMilliseconds }
  );
  const result = await page.evaluate(
    (expectedMarker) =>
      window.__tossLatexBenchmark.results.find((candidate) => candidate.marker === expectedMarker),
    marker
  );
  assert(result?.ok, "browser compile failed: " + JSON.stringify(result));
  return result;
}

async function browserResultAfter(page, previousCount) {
  await page.waitForFunction(
    (count) => window.__tossLatexBenchmark?.results.length > count,
    previousCount,
    { timeout: timeoutMilliseconds }
  );
  const result = await page.evaluate(() => window.__tossLatexBenchmark.results.at(-1));
  assert(result?.ok, "browser compile failed: " + JSON.stringify(result));
  return result;
}

function trackRuntimeResponses(page) {
  const responses = [];
  page.on("response", (response) => {
    if (!/\/busytex\/|\/v1\/latex\/texlive\//.test(response.url())) return;
    const contentLength = Number(response.headers()["content-length"] ?? 0);
    responses.push({
      status: response.status(),
      bytes: Number.isFinite(contentLength) ? contentLength : 0
    });
  });
  return {
    count: () => responses.length,
    summarizeFrom: (start) => ({
      runtime_request_count: responses.length - start,
      runtime_transfer_bytes: responses
        .slice(start)
        .reduce((total, response) => total + response.bytes, 0)
    })
  };
}

async function newBrowserContext(browser, account) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(installBrowserProbe);
  await signInBrowser(context, account);
  return context;
}

async function benchmarkBrowser(browser, account, project, engine) {
  const coldMarker = engine + "-frontend-cold";
  const cold = [];
  for (let index = 0; index < coldRuns; index += 1) {
    console.error("frontend " + engine + " cold " + (index + 1) + "/" + coldRuns);
    const context = await newBrowserContext(browser, account);
    const page = await context.newPage();
    const runtimeResponses = trackRuntimeResponses(page);
    const responseStart = runtimeResponses.count();
    await page.goto(coreUrl + "/project/" + project.id);
    const result = await browserResult(page, coldMarker);
    Object.assign(result, runtimeResponses.summarizeFrom(responseStart));
    cold.push(result);
    await context.close();
  }

  const context = await newBrowserContext(browser, account);
  const page = await context.newPage();
  const runtimeResponses = trackRuntimeResponses(page);
  await page.goto(coreUrl + "/project/" + project.id);
  await browserResult(page, coldMarker);
  const warm = [];
  for (let index = 1; index <= runs; index += 1) {
    console.error("frontend " + engine + " warm " + index + "/" + runs);
    const previousCount = await page.evaluate(
      () => window.__tossLatexBenchmark.results.length
    );
    const responseStart = runtimeResponses.count();
    const started = performance.now();
    const editor = page.locator(".cm-content[contenteditable='true']");
    await editor.press("Control+End");
    await editor.press(" ");
    const result = await browserResultAfter(page, previousCount);
    result.benchmark_label = engine + "-frontend-warm-" + index;
    result.edit_to_result_ms = performance.now() - started;
    Object.assign(result, runtimeResponses.summarizeFrom(responseStart));
    warm.push(result);
  }
  await context.close();
  return { cold, warm };
}

async function benchmarkBackend(token, project, engine) {
  const fresh = [];
  const baseSource = sourceFor(engine, engine + "-backend-fresh");
  for (let index = 1; index <= runs; index += 1) {
    await updateProject(token, project.id, baseSource + " ".repeat(index));
    console.error("backend " + engine + " fresh " + index + "/" + runs);
    const submittedAt = new Date().toISOString();
    const started = performance.now();
    const submitted = await submitBuild(token, project.id);
    assert(submitted.status === 202, "fresh backend build was not asynchronous");
    const job = await waitForJob(token, submitted.body.id);
    fresh.push({
      job_id: job.id,
      e2e_wall_ms: performance.now() - started,
      submitted_at: submittedAt,
      observed_succeeded_at: new Date().toISOString(),
      attempt_count: job.attempt_count,
      processor_contract: job.processor_contract,
      artifact_bytes: job.artifacts.find((artifact) => artifact.role === "pdf")?.size_bytes ?? 0
    });
    assert(job.attempt_count === 1, "fresh backend build did not use exactly one attempt");
  }

  console.error("backend " + engine + " exact artifact cache");
  const cacheStarted = performance.now();
  const submitted = await submitBuild(token, project.id);
  assert(submitted.status === 202, "cache build was not admitted as a new job");
  const cachedJob = await waitForJob(token, submitted.body.id);
  assert(cachedJob.attempt_count === 0, "exact backend cache hit consumed a worker attempt");
  return {
    fresh,
    exact_cache: {
      job_id: cachedJob.id,
      e2e_wall_ms: performance.now() - cacheStarted,
      attempt_count: cachedJob.attempt_count
    }
  };
}

function workerDurations(jobIds) {
  let raw;
  try {
    raw = execFileSync(
      "docker",
      ["logs", "--timestamps", "--since", startedAt.toISOString(), workerContainer],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
    ).replace(/\u001b\[[0-9;]*m/g, "");
  } catch {
    console.error(
      "worker logs unavailable; set LATEX_WORKER_CONTAINER for claim-to-delivery timings"
    );
    return new Map();
  }
  const result = new Map();
  for (const jobId of jobIds) {
    const lines = raw.split("\n").filter((line) => line.includes(jobId));
    const started = lines.find((line) => line.includes("processing claim started"));
    const delivered = lines.find((line) => line.includes("processing delivery accepted"));
    if (!started || !delivered) continue;
    const startedTimestamp = Date.parse(started.split(" ")[0]);
    const deliveredTimestamp = Date.parse(delivered.split(" ")[0]);
    if (Number.isFinite(startedTimestamp) && Number.isFinite(deliveredTimestamp)) {
      result.set(jobId, {
        claim_started_at: new Date(startedTimestamp).toISOString(),
        delivery_accepted_at: new Date(deliveredTimestamp).toISOString(),
        claim_to_delivery_ms: deliveredTimestamp - startedTimestamp
      });
    }
  }
  return result;
}

function commandVersion(command) {
  try {
    return execFileSync("docker", ["exec", workerContainer, command, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split("\n")[0]
      .trim();
  } catch {
    return "unavailable";
  }
}

function browserSummary(samples) {
  return {
    compiler_wall: summarize(samples.map((sample) => sample.worker_wall_ms)),
    user_path_wall: summarize(
      samples.map((sample) => sample.edit_to_result_ms ?? sample.navigation_to_result_ms)
    ),
    runtime_requests: samples.map((sample) => sample.runtime_request_count),
    runtime_transfer_bytes: samples.map((sample) => sample.runtime_transfer_bytes),
    pdf_bytes: samples.map((sample) => sample.pdf_bytes),
    raw: samples
  };
}

function backendSummary(samples, durationByJob) {
  const processorSamples = samples
    .map((sample) => durationByJob.get(sample.job_id)?.claim_to_delivery_ms)
    .filter((value) => typeof value === "number");
  return {
    e2e_wall: summarize(samples.map((sample) => sample.e2e_wall_ms)),
    claim_to_delivery_wall:
      processorSamples.length > 0 ? summarize(processorSamples) : null,
    raw: samples.map((sample) => {
      const worker = durationByJob.get(sample.job_id);
      return {
        ...sample,
        claim_to_delivery_ms: worker?.claim_to_delivery_ms ?? null,
        admission_to_claim_ms: worker
          ? Date.parse(worker.claim_started_at) - Date.parse(sample.submitted_at)
          : null,
        delivery_to_observed_success_ms: worker
          ? Date.parse(sample.observed_succeeded_at) - Date.parse(worker.delivery_accepted_at)
          : null
      };
    })
  };
}

async function main() {
  assert(Number.isInteger(runs) && runs >= 3, "LATEX_BENCHMARK_RUNS must be at least 3");
  assert(
    Number.isInteger(coldRuns) && coldRuns >= 2,
    "LATEX_BENCHMARK_COLD_RUNS must be at least 2"
  );
  assert(
    selectedEngines.length > 0 &&
      selectedEngines.every((engine) => engine === "pdftex" || engine === "xetex"),
    "LATEX_BENCHMARK_ENGINES must contain pdftex and/or xetex"
  );
  const account = await registerUser();
  const capability = await waitForCapability(account.token);
  const browserManifest = JSON.parse(
    readFileSync(new URL("../prebuilt/busytex/build-manifest.json", import.meta.url), "utf8")
  );
  const projects = {};
  for (const engine of selectedEngines) {
    projects[engine] = {
      frontend: await createProject(
        account.token,
        engine,
        "Frontend benchmark " + engine + " " + runId,
        sourceFor(engine, engine + "-frontend-cold")
      ),
      backend: await createProject(
        account.token,
        engine,
        "Backend benchmark " + engine + " " + runId,
        sourceFor(engine, engine + "-backend-initial")
      )
    };
  }

  const browser = await chromium.launch({ headless: true });
  const chromeVersion = browser.version();
  const measurements = {};
  try {
    for (const engine of selectedEngines) {
      const frontend = await benchmarkBrowser(
        browser,
        account,
        projects[engine].frontend,
        engine
      );
      const backend = await benchmarkBackend(account.token, projects[engine].backend, engine);
      measurements[engine] = { frontend, backend };
    }
  } finally {
    await browser.close();
  }

  const freshJobs = Object.values(measurements).flatMap((measurement) =>
    measurement.backend.fresh.map((sample) => sample.job_id)
  );
  const durationByJob = workerDurations(freshJobs);
  const engines = {};
  for (const engine of selectedEngines) {
    const measurement = measurements[engine];
    const canonicalSource = sourceFor(engine, engine + "-canonical");
    engines[engine] = {
      fixture: {
        utf8_bytes: Buffer.byteLength(canonicalSource),
        sha256: sha256(canonicalSource),
        generated_workload_blocks: 36
      },
      frontend: {
        cold_worker_new_browser_context: browserSummary(measurement.frontend.cold),
        warm_persistent_worker: browserSummary(measurement.frontend.warm)
      },
      backend: {
        fresh_clean_job: backendSummary(measurement.backend.fresh, durationByJob),
        exact_artifact_cache: measurement.backend.exact_cache
      }
    };
  }

  const report = {
    schema: 1,
    generated_at: new Date().toISOString(),
    core_url: coreUrl,
    samples: { frontend_cold: coldRuns, frontend_warm: runs, backend_fresh: runs },
    semantics: {
      frontend_compiler_wall:
        "LaTeX Worker postMessage to matching result; includes BusyTeX initialization, on-demand runtime fetches, and TeX reruns, but excludes PDF canvas rendering",
      frontend_user_path_wall:
        "navigation to result for cold samples; one-character editor change through debounce/collaboration to result for warm samples",
      backend_e2e_wall:
        "HTTP build submission through observed succeeded job; includes snapshot, queue, transfer, sandbox, compilation, publication, and polling error",
      backend_claim_to_delivery_wall:
        "worker log timestamp from claim start through accepted delivery; includes bundle transfer, sandbox, compilation, and artifact upload",
      cache:
        "backend exact input/options/processor-contract artifact reuse with a new authorized job"
    },
    environment: {
      host: {
        platform: os.platform() + " " + os.release(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        logical_cpus: os.cpus().length,
        total_memory_bytes: os.totalmem()
      },
      browser: {
        chrome: chromeVersion,
        busytex_runtime_version: browserManifest.runtime_version,
        busytex_source_revision: browserManifest.source?.revision ?? null
      },
      backend: {
        processor_contract:
          Object.values(measurements)[0]?.backend.fresh[0]?.processor_contract ?? null,
        pdflatex: commandVersion("pdflatex"),
        xelatex: commandVersion("xelatex"),
        latexmk: commandVersion("latexmk")
      }
    },
    engines
  };
  console.log(JSON.stringify(roundDeep(report), null, 2));
}

await main();
