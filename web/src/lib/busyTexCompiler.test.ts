import { describe, expect, it, vi } from "vitest";
import type { BusyTexConfig } from "texlyre-busytex";
import {
  BusyTexCompiler,
  type BusyTexCompileResult,
  type BusyTexFactory,
  type BusyTexTool,
} from "./busyTexCompiler";

function successfulResult(): BusyTexCompileResult {
  return {
    success: true,
    pdf: new Uint8Array([1, 2, 3]),
    log: "",
    exitCode: 0,
    logs: [],
  };
}

function fakeFactory() {
  const compileXetex = vi.fn(async () => successfulResult());
  const compilePdftex = vi.fn(async () => successfulResult());
  let onDownloadProgress: BusyTexConfig["onDownloadProgress"];
  const initialize = vi.fn(async () => {
    onDownloadProgress?.({ loaded: 24, total: 96, percent: 25 });
  });
  const terminate = vi.fn();
  const writeTexliveRemoteMisses = vi.fn(async (_keys: string[]) => undefined);
  const createRunner = vi.fn((config: BusyTexConfig) => {
    onDownloadProgress = config.onDownloadProgress;
    return {
      initialize,
      terminate,
      writeTexliveRemoteMisses,
    };
  });
  const xetex: BusyTexTool = { compile: compileXetex };
  const pdftex: BusyTexTool = { compile: compilePdftex };
  const factory: BusyTexFactory = {
    createRunner,
    createXetex: vi.fn(() => xetex),
    createPdftex: vi.fn(() => pdftex),
  };
  return {
    factory,
    createRunner,
    initialize,
    terminate,
    writeTexliveRemoteMisses,
    compileXetex,
    compilePdftex,
  };
}

const workspace = {
  entryFilePath: "paper/main.tex",
  documents: [
    { path: "paper/main.tex", content: "\\documentclass{article}" },
    { path: "paper/section.tex", content: "Section" },
  ],
  assets: [{ path: "paper/logo.png", content: new Uint8Array([4, 5]) }],
};

describe("BusyTexCompiler", () => {
  it("initializes one combined runtime and maps a XeTeX workspace", async () => {
    const fake = fakeFactory();
    const status = vi.fn();
    const compiler = new BusyTexCompiler(
      {
        basePath: "/busytex/1.2.3",
        remoteEndpoint: "https://example.test/v1/latex/texlive",
        onStatus: status,
      },
      fake.factory,
    );

    const result = await compiler.compile({ ...workspace, engine: "xetex" });

    expect(result).toEqual(successfulResult());
    expect(fake.createRunner).toHaveBeenCalledWith({
      busytexBasePath: "/busytex/1.2.3",
      engineMode: "combined",
      preloadDataPackages: ["/busytex/1.2.3/texlive-basic.js"],
      catalogDataPackages: [],
      onDownloadProgress: expect.any(Function),
    });
    expect(fake.initialize).toHaveBeenCalledWith(true);
    expect(fake.writeTexliveRemoteMisses).toHaveBeenCalledOnce();
    const misses = fake.writeTexliveRemoteMisses.mock.calls[0]?.[0] ?? [];
    expect(new Set(misses).size).toBe(misses.length);
    expect(misses).toEqual(
      expect.arrayContaining([
        "26/main.aux",
        "26/main.out",
        "26/main.run.xml",
        "26/section.aux",
      ]),
    );
    expect(fake.compileXetex).toHaveBeenCalledWith({
      input: "\\documentclass{article}",
      mainTexPath: "paper/main.tex",
      additionalFiles: [
        { path: "paper/section.tex", content: "Section" },
        { path: "paper/logo.png", content: new Uint8Array([4, 5]) },
      ],
      remoteEndpoint: "https://example.test/v1/latex/texlive",
      rerun: true,
      shellEscape: false,
    });
    expect(status.mock.calls.map(([value]) => value)).toEqual([
      { stage: "downloading-compiler" },
      { stage: "downloading-compiler", loadedBytes: 24, totalBytes: 96 },
      { stage: "compiling" },
    ]);
  });

  it("reuses the initialized runtime across engines", async () => {
    const fake = fakeFactory();
    const compiler = new BusyTexCompiler(
      {
        basePath: "/busytex/1.2.3",
        remoteEndpoint: "/v1/latex/texlive",
        onStatus: () => undefined,
      },
      fake.factory,
    );

    await compiler.compile({ ...workspace, engine: "xetex" });
    await compiler.compile({ ...workspace, engine: "pdftex" });

    expect(fake.createRunner).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(fake.compileXetex).toHaveBeenCalledTimes(1);
    expect(fake.compilePdftex).toHaveBeenCalledTimes(1);
  });

  it("discards a runtime that fails to initialize", async () => {
    const firstInitialize = vi.fn(async () => {
      throw new Error("runtime failed");
    });
    const secondInitialize = vi.fn(async () => undefined);
    const firstTerminate = vi.fn();
    const secondTerminate = vi.fn();
    const runners = [
      {
        initialize: firstInitialize,
        terminate: firstTerminate,
        writeTexliveRemoteMisses: vi.fn(async (_keys: string[]) => undefined),
      },
      {
        initialize: secondInitialize,
        terminate: secondTerminate,
        writeTexliveRemoteMisses: vi.fn(async (_keys: string[]) => undefined),
      },
    ];
    const tool: BusyTexTool = { compile: vi.fn(async () => successfulResult()) };
    const factory: BusyTexFactory = {
      createRunner: vi.fn(() => {
        const runner = runners.shift();
        if (!runner) throw new Error("missing fake runner");
        return runner;
      }),
      createXetex: () => tool,
      createPdftex: () => tool,
    };
    const compiler = new BusyTexCompiler(
      {
        basePath: "/busytex/1.2.3",
        remoteEndpoint: "/v1/latex/texlive",
        onStatus: () => undefined,
      },
      factory,
    );

    await expect(
      compiler.compile({ ...workspace, engine: "xetex" }),
    ).rejects.toThrow("runtime failed");
    await expect(
      compiler.compile({ ...workspace, engine: "xetex" }),
    ).resolves.toEqual(successfulResult());

    expect(firstTerminate).toHaveBeenCalledOnce();
    expect(secondInitialize).toHaveBeenCalledOnce();
  });
});
