import { randomUUID } from "node:crypto";
import { waitFor } from "./release-resilience-process.mjs";

const PROCESSING_OPERATION = "latex.compile.pdf/v1";

export function createProcessingRecoveryHarness({
  api,
  processorContract,
  timeoutMs,
  workerToken,
}) {
  function processingOffers() {
    return [
      {
        operation: PROCESSING_OPERATION,
        processor_contract: processorContract,
        slots: 1,
      },
    ];
  }

  async function acquireProcessingClaim(sessionId, expectedJobId, label) {
    let acquiredClaim = null;
    await waitFor(
      async () => {
        const response = await api(
          "POST",
          "/internal/v1/processing/claims:acquire",
          workerToken,
          {
            request_id: randomUUID(),
            session_id: sessionId,
            offers: processingOffers(),
            wait_seconds: 0,
          }
        );
        const claim = response?.claims?.[0];
        if (!claim) return false;
        if (claim.job_id !== expectedJobId) {
          throw new Error(
            `${label} acquired unexpected processing job ${claim.job_id}`
          );
        }
        acquiredClaim = claim;
        return true;
      },
      timeoutMs,
      label
    );
    return acquiredClaim;
  }

  async function prepare(owner, runId) {
    if (!workerToken) return null;
    const project = await api("POST", "/v1/projects", owner.sessionToken, {
      name: `Release processing ${runId}`,
      project_type: "latex",
      latex_engine: "xetex",
    });
    await api(
      "PUT",
      `/v1/projects/${project.id}/documents/by-path/main.tex`,
      owner.sessionToken,
      {
        content: `\\documentclass{article}\n\\begin{document}\n${runId}\n\\end{document}\n`,
      }
    );
    const session = await api(
      "POST",
      "/internal/v1/processing/worker-sessions",
      workerToken,
      {
        request_id: randomUUID(),
        worker_instance: `release-resilience-${runId}`,
        protocol_versions: [1],
        processors: [
          {
            operation: PROCESSING_OPERATION,
            processor_contract: processorContract,
            runtime_version: "release-resilience/1",
            slots: 1,
          },
        ],
      }
    );
    const job = await api(
      "POST",
      `/v1/projects/${project.id}/builds`,
      owner.sessionToken,
      {},
      { "idempotency-key": randomUUID() }
    );
    const claim = await acquireProcessingClaim(
      session.session_id,
      job.id,
      "initial processing claim"
    );
    return {
      claim,
      jobId: job.id,
      sessionId: session.session_id,
    };
  }

  async function heartbeatClaim(fixture, claim) {
    await api(
      "POST",
      `/internal/v1/processing/worker-sessions/${fixture.sessionId}/heartbeat`,
      workerToken,
      {
        request_id: randomUUID(),
        processors: [
          {
            operation: PROCESSING_OPERATION,
            processor_contract: processorContract,
            healthy: true,
          },
        ],
      }
    );
    const heartbeat = await api(
      "POST",
      `/internal/v1/processing/claims/${claim.claim_id}/heartbeat`,
      workerToken,
      {
        request_id: randomUUID(),
        session_id: fixture.sessionId,
        phase: "processing",
      }
    );
    if (heartbeat.state !== "active") {
      throw new Error(
        `Replacement reported processing claim as ${heartbeat.state}`
      );
    }
  }

  async function releaseClaim(fixture, claim, reason) {
    await api(
      "POST",
      `/internal/v1/processing/claims/${claim.claim_id}/release`,
      workerToken,
      {
        request_id: randomUUID(),
        session_id: fixture.sessionId,
        reason,
      }
    );
  }

  async function recover(fixture, owner) {
    if (!fixture) return null;
    await heartbeatClaim(fixture, fixture.claim);
    await releaseClaim(
      fixture,
      fixture.claim,
      "release_resilience_recovery_probe"
    );
    const reacquired = await acquireProcessingClaim(
      fixture.sessionId,
      fixture.jobId,
      "replacement processing reacquisition"
    );
    if (reacquired.claim_id === fixture.claim.claim_id) {
      throw new Error("Replacement reused a released processing claim ID");
    }
    await heartbeatClaim(fixture, reacquired);
    await releaseClaim(
      fixture,
      reacquired,
      "release_resilience_reacquisition_complete"
    );
    const cancelled = await api(
      "POST",
      `/v1/processing/jobs/${fixture.jobId}/cancel`,
      owner.sessionToken
    );
    if (cancelled.state !== "cancelled") {
      throw new Error(`Recovered processing job ended in ${cancelled.state}`);
    }
    await api(
      "DELETE",
      `/internal/v1/processing/worker-sessions/${fixture.sessionId}`,
      workerToken,
      { request_id: randomUUID() }
    );
    return {
      initialClaimId: fixture.claim.claim_id,
      reacquiredClaimId: reacquired.claim_id,
    };
  }

  return { prepare, recover };
}
