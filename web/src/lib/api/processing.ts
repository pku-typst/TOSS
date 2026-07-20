import {
  apiUrl,
  authCredentials,
  authHeaders,
  parseJsonOrThrow,
  throwApiError
} from "@/lib/api/core";
import type {
  ProcessingCapabilities,
  ProcessingJob,
  ProcessingJobList,
  PptxConversionMode,
  ProjectProcessingCapabilities
} from "@/lib/api/types";

const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function listProcessingJobs() {
  const response = await fetch(apiUrl("/v1/processing/jobs"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProcessingJobList>(response, "processing.loadFailed");
}

export async function getProcessingCapabilities() {
  const response = await fetch(apiUrl("/v1/processing/capabilities"), {
    cache: "no-store",
    credentials: authCredentials(),
    headers: authHeaders()
  });
  return parseJsonOrThrow<ProcessingCapabilities>(
    response,
    "processing.capabilitiesFailed"
  );
}

export async function getProjectProcessingCapabilities(projectId: string) {
  const response = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/processing/capabilities`),
    {
      cache: "no-store",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ProjectProcessingCapabilities>(
    response,
    "processing.capabilitiesFailed"
  );
}

export async function createLatexPdfBuild(projectId: string) {
  const response = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/builds`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders({
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID()
      }),
      body: "{}"
    }
  );
  return parseJsonOrThrow<ProcessingJob>(response, "processing.submitFailed");
}

export async function createTypstPptxExport(
  projectId: string,
  mode: PptxConversionMode
) {
  const response = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/exports/pptx`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders({
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID()
      }),
      body: JSON.stringify({ mode })
    }
  );
  return parseJsonOrThrow<ProcessingJob>(response, "processing.submitFailed");
}

export async function createPptxImport(file: File, mode: PptxConversionMode) {
  const query = new URLSearchParams({ filename: file.name, mode });
  const response = await fetch(apiUrl(`/v1/imports/pptx?${query.toString()}`), {
    method: "POST",
    credentials: authCredentials(),
    headers: authHeaders({
      "content-type": PPTX_MEDIA_TYPE,
      "idempotency-key": crypto.randomUUID()
    }),
    body: file
  });
  return parseJsonOrThrow<ProcessingJob>(response, "processing.submitFailed");
}

export async function cancelProcessingJob(jobId: string) {
  const response = await fetch(
    apiUrl(`/v1/processing/jobs/${encodeURIComponent(jobId)}/cancel`),
    {
      method: "POST",
      credentials: authCredentials(),
      headers: authHeaders()
    }
  );
  return parseJsonOrThrow<ProcessingJob>(response, "processing.cancelFailed");
}

export async function downloadProcessingArtifact(downloadUrl: string) {
  const response = await fetch(apiUrl(downloadUrl), {
    credentials: authCredentials(),
    headers: authHeaders()
  });
  if (!response.ok) await throwApiError(response, "processing.downloadFailed");
  return response.blob();
}
