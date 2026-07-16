import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatexPdfBuild } from "@/lib/api/processing";
import type { ProcessingJob } from "@/lib/api/types";

const responseJob: ProcessingJob = {
  id: "job-1",
  operation: "latex.compile.pdf/v1",
  project_id: "project/with spaces",
  state: "queued",
  phase: "waiting_for_worker",
  cancellation_requested: false,
  attempt_count: 0,
  processor_contract: null,
  failure: null,
  artifacts: [],
  created_at: "2026-07-14T00:00:00Z",
  updated_at: "2026-07-14T00:00:00Z",
  completed_at: null
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("document processing API", () => {
  it("submits a semantic build command with a fresh idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseJob), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "request-id-1" });

    await expect(createLatexPdfBuild("project/with spaces")).resolves.toEqual(responseJob);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/projects/project%2Fwith%20spaces/builds");
    expect(init).toMatchObject({ method: "POST", credentials: "include", body: "{}" });
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "idempotency-key": "request-id-1"
    });
  });
});
