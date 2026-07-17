import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { projectContentEpochHeader } from "./lib/project-content-epoch.mjs";
import { createReleaseResilienceBrowserHarness } from "./lib/release-resilience-browser.mjs";
import {
  createCoreProcessHarness,
  holdIncompleteRequestBody,
  waitFor,
} from "./lib/release-resilience-process.mjs";
import { createProcessingRecoveryHarness } from "./lib/release-resilience-processing.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const resolveRepoPath = (configured, fallback) =>
  path.resolve(repoRoot, configured ?? fallback);
const corePort = Number(process.env.CORE_API_PORT ?? "18080");
const coreApi = `http://127.0.0.1:${corePort}`;
const coreBinary = resolveRepoPath(
  process.env.CORE_API_BIN,
  "backend/target/debug/core-api"
);
const webStaticDir = resolveRepoPath(
  process.env.WEB_STATIC_DIR,
  "web/dist"
);
const dataDir = resolveRepoPath(
  process.env.RELEASE_RESILIENCE_DATA_DIR ?? process.env.DATA_DIR,
  path.join(os.tmpdir(), `toss-release-resilience-${process.pid}`)
);
const gitStoragePath = resolveRepoPath(
  process.env.RELEASE_RESILIENCE_GIT_DIR ??
    process.env.GIT_STORAGE_PATH,
  path.join(dataDir, "git")
);
const logDir = resolveRepoPath(
  process.env.RELEASE_RESILIENCE_LOG_DIR,
  path.join(dataDir, "logs")
);
const distributionConfig = resolveRepoPath(
  process.env.TOSS_CONFIG,
  "distributions/community/toss.json"
);
const deploymentConfig = resolveRepoPath(
  process.env.TOSS_DEPLOYMENT_CONFIG,
  "config/deployment.toml"
);
const processingWorkerToken = process.env.PROCESSING_WORKER_TOKEN?.trim() ?? "";
const processingContract =
  process.env.PROCESSING_PROCESSOR_CONTRACT?.trim() ?? "";

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 30_000;

function assertEnvironment() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL must point to a disposable PostgreSQL database");
  }
  if (!Number.isInteger(corePort) || corePort < 1 || corePort > 65_535) {
    throw new Error(`CORE_API_PORT is invalid: ${process.env.CORE_API_PORT}`);
  }
  if (Boolean(processingWorkerToken) !== Boolean(processingContract)) {
    throw new Error(
      "PROCESSING_WORKER_TOKEN and PROCESSING_PROCESSOR_CONTRACT must be set together"
    );
  }
}

function assertGracefulStop(result, label) {
  if (result.forced || result.code !== 0) {
    throw new Error(
      `${label} did not stop cleanly: ${JSON.stringify(result)}`
    );
  }
}

async function parseJson(response) {
  if (response.status === 204) return null;
  const raw = await response.text();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Expected JSON (${response.status}): ${raw}`);
  }
}

async function api(method, route, token, body, extraHeaders = {}) {
  const contentEpochHeader = await projectContentEpochHeader(
    coreApi,
    method,
    route,
    token
  );
  const response = await fetch(`${coreApi}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...contentEpochHeader,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `${method} ${route} failed (${response.status}): ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

const { readLogTail, startCore, stopCore, waitForCoreReady } =
  createCoreProcessHarness({
    coreApi,
    coreBinary,
    corePort,
    dataDir,
    deploymentConfig,
    distributionConfig,
    gitStoragePath,
    logDir,
    repoRoot,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    webStaticDir,
  });

const {
  appendEditorText,
  countOccurrences,
  editorText,
  installRealtimeProbe,
  login,
  openWorkspace,
  realtimeBaseline,
  saveEditor,
  setMutationHold,
  waitForEditorText,
  waitForHeldMutation,
  waitForInitialRealtime,
  waitForRealtimeAcknowledgement,
  waitForRealtimeClosed,
  waitForRealtimeReopened,
} = createReleaseResilienceBrowserHarness({
  coreApi,
  timeoutMs: BROWSER_TIMEOUT_MS,
});

const {
  prepare: prepareProcessingRecovery,
  recover: recoverProcessingClaim,
} = createProcessingRecoveryHarness({
  api,
  processorContract: processingContract,
  timeoutMs: BROWSER_TIMEOUT_MS,
  workerToken: processingWorkerToken,
});

async function register(email, password, displayName) {
  const username = email
    .split("@")[0]
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 32);
  const response = await fetch(`${coreApi}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName,
    }),
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(
      `Registration failed (${response.status}): ${JSON.stringify(payload)}`
    );
  }
  return {
    email,
    password,
    userId: payload.user_id,
    sessionToken: payload.session_token,
  };
}

async function waitForDocumentContent(projectId, documentId, token, markers) {
  await waitFor(
    async () => {
      const document = await api(
        "GET",
        `/v1/projects/${projectId}/documents/${documentId}`,
        token
      );
      return markers.every((marker) => document.content.includes(marker));
    },
    BROWSER_TIMEOUT_MS,
    `durable document content (${markers.join(", ")})`
  );
}

async function revisionContent(projectId, revisionId, token) {
  const transfer = await api(
    "GET",
    `/v1/projects/${projectId}/revisions/${revisionId}/documents`,
    token
  );
  const document = transfer.documents.find((entry) => entry.path === "main.typ");
  if (!document) throw new Error(`Revision ${revisionId} is missing main.typ`);
  return document.content;
}

async function main() {
  assertEnvironment();
  await Promise.all([
    fs.access(coreBinary),
    fs.access(path.join(webStaticDir, "index.html")),
    fs.access(distributionConfig),
    fs.access(deploymentConfig),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(gitStoragePath, { recursive: true }),
    fs.mkdir(logDir, { recursive: true }),
  ]);

  const runId = `${Date.now()}-${process.pid}`;
  const firstMarker = `Acknowledged before restart ${runId}`;
  const dirtyWorkspaceMarker = `Dirty workspace before restart ${runId}`;
  const pendingMarker = `Pending during restart ${runId}`;
  const secondMarker = `Collaborated after restart ${runId}`;
  let activeCore = null;
  let browser = null;
  let contextA = null;
  let contextB = null;
  let pageA = null;
  let pageB = null;
  let incompleteRequest = null;

  try {
    const coreA = startCore("a");
    activeCore = coreA;
    const startupAMs = await waitForCoreReady(coreA);

    const owner = await register(
      `release-owner-${runId}@example.com`,
      "Owner1234!",
      "Release Owner"
    );
    const collaborator = await register(
      `release-collaborator-${runId}@example.com`,
      "Collaborator1234!",
      "Release Collaborator"
    );
    const project = await api("POST", "/v1/projects", owner.sessionToken, {
      name: `Release resilience ${runId}`,
    });
    await api(
      "POST",
      `/v1/projects/${project.id}/roles`,
      owner.sessionToken,
      { user_id: collaborator.userId, role: "ReadWrite" }
    );
    const document = await api(
      "PUT",
      `/v1/projects/${project.id}/documents/by-path/main.typ`,
      owner.sessionToken,
      { content: "= Release resilience\n\nInitial content.\n" }
    );
    const processingFixture = await prepareProcessingRecovery(owner, runId);

    browser = await chromium.launch({ headless: true });
    contextA = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    contextB = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    await Promise.all([
      installRealtimeProbe(contextA),
      installRealtimeProbe(contextB),
    ]);
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();

    await Promise.all([login(pageA, owner), login(pageB, collaborator)]);
    await Promise.all([
      openWorkspace(pageA, project.id),
      openWorkspace(pageB, project.id),
    ]);
    const [baselineA, baselineB] = await Promise.all([
      waitForInitialRealtime(pageA, "owner"),
      waitForInitialRealtime(pageB, "collaborator"),
    ]);

    await appendEditorText(pageA, firstMarker);
    await waitForEditorText(
      pageB,
      firstMarker,
      "pre-restart update on collaborator"
    );
    await saveEditor(pageA);
    await waitForRealtimeAcknowledgement(
      pageA,
      baselineA,
      "pre-restart update"
    );
    await waitForDocumentContent(
      project.id,
      document.id,
      owner.sessionToken,
      [firstMarker]
    );
    const revisionA = await api(
      "POST",
      `/v1/projects/${project.id}/revisions`,
      owner.sessionToken,
      { summary: "Before process replacement" }
    );
    const beforeRevisionContent = await revisionContent(
      project.id,
      revisionA.id,
      owner.sessionToken
    );
    if (!beforeRevisionContent.includes(firstMarker)) {
      throw new Error("Pre-restart Git revision omitted acknowledged content");
    }

    const dirtyAckBaselineB = await realtimeBaseline(pageB);
    await appendEditorText(pageB, dirtyWorkspaceMarker);
    await waitForEditorText(
      pageA,
      dirtyWorkspaceMarker,
      "dirty workspace update on owner"
    );
    await saveEditor(pageB);
    await waitForRealtimeAcknowledgement(
      pageB,
      dirtyAckBaselineB,
      "dirty workspace update"
    );
    await waitForDocumentContent(
      project.id,
      document.id,
      owner.sessionToken,
      [firstMarker, dirtyWorkspaceMarker]
    );
    if (beforeRevisionContent.includes(dirtyWorkspaceMarker)) {
      throw new Error("Existing Git revision changed with the dirty workspace");
    }

    const holdBaselineA = await realtimeBaseline(pageA);
    await setMutationHold(pageA, true);
    await appendEditorText(pageA, pendingMarker);
    await waitForHeldMutation(pageA, holdBaselineA, "pre-restart update");
    if ((await editorText(pageB)).includes(pendingMarker)) {
      throw new Error("Held pending update unexpectedly reached the collaborator");
    }
    const restartBaselineA = await realtimeBaseline(pageA);
    const restartBaselineB = await realtimeBaseline(pageB);
    const interruptionStartedAt = Date.now();
    const [stopA, closedAAt, closedBAt] = await Promise.all([
      stopCore(coreA),
      waitForRealtimeClosed(pageA, restartBaselineA, "owner"),
      waitForRealtimeClosed(pageB, restartBaselineB, "collaborator"),
    ]);
    assertGracefulStop(stopA, "Core A");
    activeCore = null;
    await setMutationHold(pageA, false);

    const coreB = startCore("b");
    activeCore = coreB;
    const startupBMs = await waitForCoreReady(coreB);
    const replacementReadyAt = Date.now();
    const [reopenedAAt, reopenedBAt, processingRecovery] = await Promise.all([
      waitForRealtimeReopened(pageA, restartBaselineA, "owner"),
      waitForRealtimeReopened(pageB, restartBaselineB, "collaborator"),
      recoverProcessingClaim(processingFixture, owner),
    ]);
    const reconnectAfterReadyMs = {
      owner: reopenedAAt - replacementReadyAt,
      collaborator: reopenedBAt - replacementReadyAt,
    };
    if (Math.max(...Object.values(reconnectAfterReadyMs)) >= 5_000) {
      throw new Error("Service-restart reconnect did not use the fast retry path");
    }
    await waitForRealtimeAcknowledgement(
      pageA,
      restartBaselineA,
      "pending state recovery"
    );

    await Promise.all([
      waitForEditorText(pageA, firstMarker, "owner state after reconnect"),
      waitForEditorText(pageB, firstMarker, "collaborator state after reconnect"),
      waitForEditorText(
        pageA,
        dirtyWorkspaceMarker,
        "owner dirty workspace after reconnect"
      ),
      waitForEditorText(
        pageB,
        dirtyWorkspaceMarker,
        "collaborator dirty workspace after reconnect"
      ),
      waitForEditorText(pageA, pendingMarker, "owner pending state after reconnect"),
      waitForEditorText(
        pageB,
        pendingMarker,
        "collaborator pending state after reconnect"
      ),
    ]);
    const [ownerRecoveredText, collaboratorRecoveredText] = await Promise.all([
      editorText(pageA),
      editorText(pageB),
    ]);
    if (
      countOccurrences(ownerRecoveredText, pendingMarker) !== 1 ||
      countOccurrences(collaboratorRecoveredText, pendingMarker) !== 1
    ) {
      throw new Error("Pending state was duplicated after reconnect");
    }
    await waitForDocumentContent(
      project.id,
      document.id,
      owner.sessionToken,
      [firstMarker, dirtyWorkspaceMarker, pendingMarker]
    );
    const recoveredRevisionContent = await revisionContent(
      project.id,
      revisionA.id,
      owner.sessionToken
    );
    if (!recoveredRevisionContent.includes(firstMarker)) {
      throw new Error("Replacement process could not read the existing Git revision");
    }

    await appendEditorText(pageB, secondMarker);
    await waitForEditorText(
      pageA,
      secondMarker,
      "post-restart update on owner"
    );
    await saveEditor(pageB);
    await waitForDocumentContent(
      project.id,
      document.id,
      owner.sessionToken,
      [firstMarker, dirtyWorkspaceMarker, pendingMarker, secondMarker]
    );
    const revisionB = await api(
      "POST",
      `/v1/projects/${project.id}/revisions`,
      owner.sessionToken,
      { summary: "After process replacement" }
    );
    const afterRevisionContent = await revisionContent(
      project.id,
      revisionB.id,
      owner.sessionToken
    );
    if (
      !afterRevisionContent.includes(firstMarker) ||
      !afterRevisionContent.includes(dirtyWorkspaceMarker) ||
      !afterRevisionContent.includes(pendingMarker) ||
      !afterRevisionContent.includes(secondMarker)
    ) {
      throw new Error("Post-restart Git revision omitted collaborative content");
    }

    const stopB = await stopCore(coreB);
    assertGracefulStop(stopB, "Core B");
    activeCore = null;
    const coreC = startCore("deadline", {
      CORE_DRAIN_TIMEOUT_SECONDS: "1",
    });
    activeCore = coreC;
    const startupCMs = await waitForCoreReady(coreC);
    incompleteRequest = await holdIncompleteRequestBody({
      coreApi,
      method: "PUT",
      route: `/v1/projects/${project.id}/documents/by-path/main.typ`,
      token: owner.sessionToken,
      timeoutMs: BROWSER_TIMEOUT_MS,
    });
    const stopC = await stopCore(coreC);
    activeCore = null;
    incompleteRequest.destroy();
    incompleteRequest = null;
    if (stopC.forced || stopC.durationMs < 800 || stopC.code === 0) {
      throw new Error(
        `Drain deadline exhaustion was not observable: ${JSON.stringify(stopC)}`,
      );
    }

    const coreD = startCore("deadline-recovery");
    activeCore = coreD;
    const startupDMs = await waitForCoreReady(coreD);
    await waitForDocumentContent(
      project.id,
      document.id,
      owner.sessionToken,
      [firstMarker, dirtyWorkspaceMarker, pendingMarker, secondMarker],
    );
    const deadlineRecoveryRevision = await revisionContent(
      project.id,
      revisionB.id,
      owner.sessionToken,
    );
    if (!deadlineRecoveryRevision.includes(secondMarker)) {
      throw new Error("Replacement could not reconstruct state after deadline exhaustion");
    }
    const stopD = await stopCore(coreD);
    assertGracefulStop(stopD, "Core D");
    activeCore = null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          topology: "single-replica-recreate",
          project_id: project.id,
          startup_ms: {
            process_a: startupAMs,
            process_b: startupBMs,
            deadline_process: startupCMs,
            recovery_process: startupDMs,
          },
          termination_ms: {
            process_a: stopA.durationMs,
            process_b: stopB.durationMs,
            deadline_process: stopC.durationMs,
            recovery_process: stopD.durationMs,
          },
          forced_termination: {
            process_a: stopA.forced,
            process_b: stopB.forced,
            deadline_process: stopC.forced,
            recovery_process: stopD.forced,
          },
          interruption_ms: replacementReadyAt - interruptionStartedAt,
          socket_close_ms: {
            owner: closedAAt - interruptionStartedAt,
            collaborator: closedBAt - interruptionStartedAt,
          },
          reconnect_after_ready_ms: {
            ...reconnectAfterReadyMs,
          },
          assertions: {
            acknowledged_update_survived: true,
            active_page_pending_update_recovered: true,
            service_restart_close_code: true,
            fast_restart_reconnect: true,
            document_and_control_streams_reconnected: true,
            two_browser_contexts_converged: true,
            dirty_workspace_flushable_after_restart: true,
            git_revision_readable_after_restart: true,
            git_revision_writable_after_restart: true,
            drain_deadline_exhaustion_observed: true,
            state_reconstructed_after_deadline_exhaustion: true,
            ...(processingFixture === null
              ? {}
              : { processing_claim_recovered: processingRecovery !== null }),
          },
          optional_scenarios: {
            processing_claim_recovery:
              processingFixture === null ? "not_configured" : "passed",
          },
        },
        null,
        2
      )
    );
  } catch (error) {
    if (activeCore) {
      const tail = await readLogTail(activeCore.logPath);
      if (tail.trim()) console.error(`Core ${activeCore.label} log tail:\n${tail}`);
    }
    throw error;
  } finally {
    incompleteRequest?.destroy();
    await pageA?.close().catch(() => undefined);
    await pageB?.close().catch(() => undefined);
    await contextA?.close().catch(() => undefined);
    await contextB?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (activeCore) await stopCore(activeCore).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
});
