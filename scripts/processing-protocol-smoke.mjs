import { createHash, randomUUID } from "node:crypto";

const coreUrl = (process.env.CORE_API_URL ?? "http://127.0.0.1:18080").replace(/\/$/, "");
const workerToken = process.env.PROCESSING_WORKER_TOKEN?.trim();
const processorContract = process.env.PROCESSING_PROCESSOR_CONTRACT?.trim();

if (!workerToken || !processorContract) {
  throw new Error("PROCESSING_WORKER_TOKEN and PROCESSING_PROCESSOR_CONTRACT are required");
}

const operation = "latex.compile.pdf/v1";
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

async function request(method, path, { token, worker = false, body, headers, statuses = [200] } = {}) {
  const response = await fetch(`${coreUrl}${path}`, {
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

async function rawRequest(method, path, { authorization, body, statuses = [200] }) {
  const response = await fetch(`${coreUrl}${path}`, {
    method,
    headers: authorization ? { authorization } : {},
    body
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!statuses.includes(response.status)) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${statuses.join("/")}: ${bytes.toString("utf8")}`
    );
  }
  return { status: response.status, bytes, headers: response.headers };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function registerUser() {
  const result = await request("POST", "/v1/auth/local/register", {
    body: {
      email: `processing-${runId}@example.test`,
      password: "Processing1234!",
      username: `processing-${runId}`.slice(0, 32),
      display_name: "Processing Protocol Smoke"
    },
    statuses: [200, 201]
  });
  assert(typeof result.body?.session_token === "string", "registration did not return a session token");
  return result.body.session_token;
}

function capability(payload) {
  return payload?.capabilities?.find((entry) => entry.operation === operation);
}

async function submitBuild(projectId, sessionToken, idempotencyKey) {
  return request("POST", `/v1/projects/${projectId}/builds`, {
    token: sessionToken,
    body: {},
    headers: { "idempotency-key": idempotencyKey },
    statuses: [200, 202]
  });
}

async function createLatexProject(sessionToken, name) {
  const project = (
    await request("POST", "/v1/projects", {
      token: sessionToken,
      body: {
        name,
        project_type: "latex",
        latex_engine: "xetex"
      },
      statuses: [200, 201]
    })
  ).body;
  assert(typeof project?.id === "string", "LaTeX project was not created");
  return project;
}

function processorOffers(slots = 1) {
  return [{ operation, processor_contract: processorContract, slots }];
}

async function readJob(jobId, sessionToken) {
  return (
    await request("GET", `/v1/processing/jobs/${jobId}`, {
      token: sessionToken,
      statuses: [200]
    })
  ).body;
}

async function waitForJob(jobId, sessionToken, expectedState, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let current = await readJob(jobId, sessionToken);
  while (current.state !== expectedState && Date.now() < deadline) {
    if (["failed", "cancelled", "expired"].includes(current.state)) {
      throw new Error(`job ${jobId} reached ${current.state}: ${JSON.stringify(current.failure)}`);
    }
    await wait(200);
    current = await readJob(jobId, sessionToken);
  }
  assert(current.state === expectedState, `job ${jobId} did not reach ${expectedState}`);
  return current;
}

async function main() {
  const sessionToken = await registerUser();
  const project = await createLatexProject(sessionToken, `Processing Smoke ${runId}`);
  const rapidProject = await createLatexProject(sessionToken, `Processing Rapid ${runId}`);
  const concurrentProject = await createLatexProject(
    sessionToken,
    `Processing Concurrent ${runId}`
  );

  const offlineCapability = capability(
    (await request("GET", "/v1/processing/capabilities", { token: sessionToken })).body
  );
  assert(offlineCapability?.state === "waiting", "configured offline worker must report waiting");

  const idempotencyKey = randomUUID();
  const firstSubmission = await submitBuild(project.id, sessionToken, idempotencyKey);
  assert(firstSubmission.status === 202, "new build was not accepted asynchronously");
  const jobId = firstSubmission.body?.id;
  assert(typeof jobId === "string", "build response did not contain a job ID");
  const duplicateSubmission = await submitBuild(project.id, sessionToken, idempotencyKey);
  assert(duplicateSubmission.status === 200, "duplicate build did not return the existing job");
  assert(duplicateSubmission.body?.id === jobId, "duplicate build created another job");

  const createSessionRequestId = randomUUID();
  const createSessionBody = {
    request_id: createSessionRequestId,
    worker_instance: `protocol-smoke-${runId}`,
    protocol_versions: [1],
    processors: [
      {
        operation,
        processor_contract: processorContract,
        runtime_version: "protocol-smoke/1",
        slots: 1
      }
    ]
  };
  const workerSession = await request("POST", "/internal/v1/processing/worker-sessions", {
    token: workerToken,
    worker: true,
    body: createSessionBody,
    statuses: [201]
  });
  const replayedSession = await request("POST", "/internal/v1/processing/worker-sessions", {
    token: workerToken,
    worker: true,
    body: createSessionBody,
    statuses: [201]
  });
  assert(
    JSON.stringify(replayedSession.body) === JSON.stringify(workerSession.body),
    "worker session retry did not replay the exact response"
  );
  const workerSessionId = workerSession.body?.session_id;
  assert(typeof workerSessionId === "string", "worker session was not created");

  const onlineCapability = capability(
    (await request("GET", "/v1/processing/capabilities", { token: sessionToken })).body
  );
  assert(onlineCapability?.state === "available", "healthy worker did not become available");

  const acquireBody = {
    request_id: randomUUID(),
    session_id: workerSessionId,
    offers: processorOffers(),
    wait_seconds: 0
  };
  const oversizedOffer = await request("POST", "/internal/v1/processing/claims:acquire", {
    token: workerToken,
    worker: true,
    body: { ...acquireBody, request_id: randomUUID(), offers: processorOffers(2) },
    statuses: [400]
  });
  assert(
    oversizedOffer.body?.code === "worker_request_invalid",
    "an offer above the registered slot ceiling was accepted"
  );
  const acquired = await request("POST", "/internal/v1/processing/claims:acquire", {
    token: workerToken,
    worker: true,
    body: acquireBody,
    statuses: [200]
  });
  const replayedAcquire = await request("POST", "/internal/v1/processing/claims:acquire", {
    token: workerToken,
    worker: true,
    body: acquireBody,
    statuses: [200]
  });
  assert(
    JSON.stringify(replayedAcquire.body) === JSON.stringify(acquired.body),
    "claim acquisition retry did not replay the exact claim"
  );
  const claim = acquired.body?.claims?.[0];
  assert(claim?.job_id === jobId, "worker claimed the wrong job");
  assert(claim?.processor_contract === processorContract, "claim contract drifted");

  await request(
    "POST",
    `/internal/v1/processing/worker-sessions/${workerSessionId}/heartbeat`,
    {
      token: workerToken,
      worker: true,
      body: {
        request_id: randomUUID(),
        processors: [
          {
            operation,
            processor_contract: processorContract,
            healthy: true
          }
        ]
      },
      statuses: [200]
    }
  );

  const input = await rawRequest("GET", claim.input.download_url, {
    authorization: `ProcessingTransfer ${claim.input.download_token}`
  });
  assert(input.bytes.length === claim.input.size_bytes, "input transfer size did not match claim");
  assert(sha256(input.bytes) === claim.input.sha256, "input transfer digest did not match claim");

  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
  const pdfDigest = sha256(pdf);
  const ticketBody = {
    request_id: randomUUID(),
    session_id: workerSessionId,
    role: "pdf",
    media_type: "application/pdf",
    filename: "main.pdf",
    size_bytes: pdf.length,
    sha256: pdfDigest
  };
  const ticket = await request(
    "POST",
    `/internal/v1/processing/claims/${claim.claim_id}/artifacts`,
    { token: workerToken, worker: true, body: ticketBody, statuses: [201] }
  );
  const replayedTicket = await request(
    "POST",
    `/internal/v1/processing/claims/${claim.claim_id}/artifacts`,
    { token: workerToken, worker: true, body: ticketBody, statuses: [201] }
  );
  assert(
    replayedTicket.body?.transfer_id === ticket.body?.transfer_id,
    "artifact ticket retry allocated a second transfer"
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await rawRequest("PUT", ticket.body.upload_url, {
      authorization: `ProcessingTransfer ${ticket.body.upload_token}`,
      body: pdf,
      statuses: [204]
    });
  }

  const completionBody = {
    request_id: randomUUID(),
    session_id: workerSessionId,
    artifacts: [
      {
        transfer_id: ticket.body.transfer_id,
        role: "pdf",
        size_bytes: pdf.length,
        sha256: pdfDigest
      }
    ],
    metadata: { smoke: true }
  };
  const completion = await request(
    "POST",
    `/internal/v1/processing/claims/${claim.claim_id}/complete`,
    { token: workerToken, worker: true, body: completionBody, statuses: [200] }
  );
  const replayedCompletion = await request(
    "POST",
    `/internal/v1/processing/claims/${claim.claim_id}/complete`,
    { token: workerToken, worker: true, body: completionBody, statuses: [200] }
  );
  assert(
    JSON.stringify(replayedCompletion.body) === JSON.stringify(completion.body),
    "claim completion retry did not replay the accepted result"
  );

  const succeeded = await waitForJob(jobId, sessionToken, "succeeded");
  const artifact = succeeded.artifacts.find((entry) => entry.role === "pdf");
  assert(artifact, "succeeded job did not publish a PDF artifact");
  const downloaded = await rawRequest("GET", artifact.download_url, {
    authorization: `Bearer ${sessionToken}`
  });
  assert(downloaded.bytes.equals(pdf), "published artifact bytes changed");

  const rapidSubmission = await submitBuild(rapidProject.id, sessionToken, randomUUID());
  const concurrentSubmission = await submitBuild(
    concurrentProject.id,
    sessionToken,
    randomUUID()
  );
  const immediateAcquireStarted = Date.now();
  const immediateAcquires = await Promise.all(
    [randomUUID(), randomUUID()].map((requestId) =>
      request("POST", "/internal/v1/processing/claims:acquire", {
        token: workerToken,
        worker: true,
        body: {
          request_id: requestId,
          session_id: workerSessionId,
          offers: processorOffers(),
          wait_seconds: 0
        },
        statuses: [200, 204]
      })
    )
  );
  const immediateAcquireMilliseconds = Date.now() - immediateAcquireStarted;
  const immediateClaims = immediateAcquires.flatMap((response) => response.body?.claims ?? []);
  assert(immediateClaims.length === 1, "one registered slot granted concurrent claims");
  assert(
    immediateAcquireMilliseconds < 2_000,
    `capacity did not become claimable immediately (${immediateAcquireMilliseconds} ms)`
  );
  const immediateClaim = immediateClaims[0];
  assert(
    [rapidSubmission.body.id, concurrentSubmission.body.id].includes(immediateClaim.job_id),
    "immediate acquire returned an unexpected job"
  );
  await request(
    "POST",
    `/internal/v1/processing/claims/${immediateClaim.claim_id}/release`,
    {
      token: workerToken,
      worker: true,
      body: {
        request_id: randomUUID(),
        session_id: workerSessionId,
        reason: "capacity_regression_complete"
      },
      statuses: [200]
    }
  );
  for (const queuedJobId of [rapidSubmission.body.id, concurrentSubmission.body.id]) {
    const stopped = (
      await request("POST", `/v1/processing/jobs/${queuedJobId}/cancel`, {
        token: sessionToken,
        statuses: [200]
      })
    ).body;
    assert(stopped.state === "cancelled", "capacity regression job was not cancelled");
  }

  const cachedSubmission = await submitBuild(project.id, sessionToken, randomUUID());
  assert(cachedSubmission.status === 202, "cache candidate was not admitted as a new job");
  const cacheAcquire = await request("POST", "/internal/v1/processing/claims:acquire", {
    token: workerToken,
    worker: true,
    body: {
      request_id: randomUUID(),
      session_id: workerSessionId,
      offers: processorOffers(),
      wait_seconds: 0
    },
    statuses: [204]
  });
  assert(cacheAcquire.body === null, "cache hit unexpectedly created a worker claim");
  const cached = await waitForJob(cachedSubmission.body.id, sessionToken, "succeeded");
  assert(cached.attempt_count === 0, "cache hit consumed a worker attempt");
  assert(cached.artifacts.some((entry) => entry.role === "pdf"), "cache hit omitted artifacts");

  const cancelledSubmission = await submitBuild(project.id, sessionToken, randomUUID());
  const cancelled = (
    await request("POST", `/v1/processing/jobs/${cancelledSubmission.body.id}/cancel`, {
      token: sessionToken,
      statuses: [200]
    })
  ).body;
  assert(cancelled.state === "cancelled", "queued cancellation did not win immediately");

  const conflict = await request(
    "DELETE",
    `/internal/v1/processing/worker-sessions/${workerSessionId}`,
    {
      token: workerToken,
      worker: true,
      body: { request_id: createSessionRequestId },
      statuses: [409]
    }
  );
  assert(conflict.body?.code === "worker_request_id_conflict", "request ID conflict was not fenced");

  await request("DELETE", `/internal/v1/processing/worker-sessions/${workerSessionId}`, {
    token: workerToken,
    worker: true,
    body: { request_id: randomUUID() },
    statuses: [204]
  });

  process.stdout.write(
    `${JSON.stringify({
      project_id: project.id,
      executed_job_id: jobId,
      cached_job_id: cached.id,
      cancelled_job_id: cancelled.id,
      immediate_reacquire_ms: immediateAcquireMilliseconds,
      processor_contract: processorContract
    })}\n`
  );
}

await main();
