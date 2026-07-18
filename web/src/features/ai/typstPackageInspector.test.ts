import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTypstPackageInspector } from "@/features/ai/typstPackageInspector";
import type { TypstPackageInspectorResponse } from "@/features/ai/typstPackageInspectorProtocol";

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond(message: TypstPackageInspectorResponse) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("browser Typst package inspector", () => {
  it("correlates worker results and validates the tool-specific response", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const inspector = new BrowserTypstPackageInspector({
      kind: "toss",
      baseUrl: "https://toss.example/v1/typst/packages/",
      withCredentials: true
    });
    const result = inspector.execute({
      tool: "list_typst_package_files",
      arguments: { package_spec: "@preview/fixture:1.2.3" }
    });
    const worker = FakeWorker.instances[0];
    expect(worker.posted[0]).toMatchObject({
      kind: "execute",
      id: 1,
      source: {
        kind: "toss",
        baseUrl: "https://toss.example/v1/typst/packages/",
        withCredentials: true
      }
    });
    worker.respond({
      id: 1,
      execution: {
        outcome: "success",
        result: {
          package_spec: "@preview/fixture:1.2.3",
          package_digest: `sha256:${"a".repeat(64)}`,
          manifest_path: "typst.toml",
          entries: [],
          offset: 0,
          total: 0,
          next_offset: null
        }
      }
    });
    await expect(result).resolves.toMatchObject({ outcome: "success" });
    inspector.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("cancels an in-flight worker request without waiting for a response", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const inspector = new BrowserTypstPackageInspector({
      kind: "preview",
      baseUrl: "https://packages.typst.org"
    });
    const controller = new AbortController();
    const result = inspector.execute({
      tool: "read_typst_package_file",
      arguments: {
        package_spec: "@local/fixture:1.2.3",
        path: "lib.typ"
      }
    }, controller.signal);
    controller.abort();
    await expect(result).resolves.toMatchObject({
      outcome: "error",
      error: { code: "workspace_request_cancelled" }
    });
    expect(FakeWorker.instances[0].posted.at(-1)).toEqual({ kind: "cancel", id: 1 });
  });
});
