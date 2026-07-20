import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLatexPdfBuild,
  createPptxImport,
  createTypstPptxExport,
  getProjectProcessingCapabilities
} from "@/lib/api/processing";
import type { ProcessingJob } from "@/lib/api/types";

const responseJob: ProcessingJob = {
  id: "job-1",
  operation: "latex.compile.pdf/v1",
  project_id: "project/with spaces",
  result_project_id: null,
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

  it("submits PPTX export options to the project operation endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseJob), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "request-id-2" });

    await createTypstPptxExport("project/with spaces", "fidelity");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/projects/project%2Fwith%20spaces/exports/pptx");
    expect(init.body).toBe('{"mode":"fidelity"}');
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "idempotency-key": "request-id-2"
    });
  });

  it("uploads a raw PPTX body with filename and mode in the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseJob), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => "request-id-3" });
    const file = new File(["pptx"], "deck & notes.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });

    await createPptxImport(file, "editable");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/imports/pptx?filename=deck+%26+notes.pptx&mode=editable");
    expect(init.body).toBe(file);
    expect(init.headers).toMatchObject({
      "content-type": file.type,
      "idempotency-key": "request-id-3"
    });
  });

  it("loads project-scoped processing applicability", async () => {
    const response = { capabilities: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getProjectProcessingCapabilities("project/with spaces")
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/projects/project%2Fwith%20spaces/processing/capabilities",
      expect.objectContaining({ cache: "no-store", credentials: "include" })
    );
  });
});
