import {
  BusyTexRunner,
  PdfLatex,
  XeLatex,
  type BusyTexConfig,
  type CompileOptions,
  type CompileResult,
} from "texlyre-busytex";
import { latexGeneratedAuxiliaryMissKeys } from "./latexRuntimeUtils";

export type BusyTexCompileResult = CompileResult;

export type BusyTexTool = {
  compile(options: CompileOptions): Promise<CompileResult>;
};

type BusyTexRunnerPort = {
  initialize(useWorker?: boolean): Promise<void>;
  writeTexliveRemoteMisses(keys: string[]): Promise<void>;
  terminate(): void;
};

export type BusyTexFactory = {
  createRunner(config: BusyTexConfig): BusyTexRunnerPort;
  createXetex(runner: BusyTexRunnerPort): BusyTexTool;
  createPdftex(runner: BusyTexRunnerPort): BusyTexTool;
};

type BusyTexCompilerStatus = {
  stage: "downloading-compiler" | "compiling";
  loadedBytes?: number;
  totalBytes?: number;
};

type BusyTexCompilerOptions = {
  basePath: string;
  remoteEndpoint: string;
  onStatus(status: BusyTexCompilerStatus): void;
};

type BusyTexWorkspace = {
  engine: "pdftex" | "xetex";
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; content: Uint8Array }>;
};

type BusyTexSession = {
  runner: BusyTexRunnerPort;
  xetex: BusyTexTool;
  pdftex: BusyTexTool;
};

const defaultFactory: BusyTexFactory = {
  createRunner: (config) => new BusyTexRunner(config),
  createXetex: (runner) => new XeLatex(runner as BusyTexRunner),
  createPdftex: (runner) => new PdfLatex(runner as BusyTexRunner),
};

export class BusyTexCompiler {
  private session: BusyTexSession | null = null;

  constructor(
    private readonly options: BusyTexCompilerOptions,
    private readonly factory: BusyTexFactory = defaultFactory,
  ) {}

  async compile(workspace: BusyTexWorkspace): Promise<CompileResult> {
    const entryDocument = workspace.documents.find(
      (document) => document.path === workspace.entryFilePath,
    );
    if (!entryDocument) {
      throw new Error(`LaTeX entry file was not found: ${workspace.entryFilePath}`);
    }
    const session = await this.ensureSession();
    const additionalFiles = [
      ...workspace.documents
        .filter((document) => document.path !== workspace.entryFilePath)
        .map((document) => ({ path: document.path, content: document.content })),
      ...workspace.assets.map((asset) => ({
        path: asset.path,
        content: asset.content,
      })),
    ];
    try {
      await session.runner.writeTexliveRemoteMisses(
        latexGeneratedAuxiliaryMissKeys(workspace.documents),
      );
      this.options.onStatus({ stage: "compiling" });
      const tool = workspace.engine === "xetex" ? session.xetex : session.pdftex;
      return await tool.compile({
        input: entryDocument.content,
        mainTexPath: workspace.entryFilePath,
        additionalFiles,
        remoteEndpoint: this.options.remoteEndpoint,
        rerun: true,
        shellEscape: false,
      });
    } catch (error) {
      this.discardSession();
      throw error;
    }
  }

  close() {
    this.discardSession();
  }

  private async ensureSession() {
    if (this.session) return this.session;
    const basePath = this.options.basePath.replace(/\/$/, "");
    const runner = this.factory.createRunner({
      busytexBasePath: basePath,
      engineMode: "combined",
      preloadDataPackages: [`${basePath}/texlive-basic.js`],
      catalogDataPackages: [],
      onDownloadProgress: ({ loaded, total }) =>
        this.options.onStatus({
          stage: "downloading-compiler",
          loadedBytes: loaded,
          totalBytes: total,
        }),
    });
    this.options.onStatus({ stage: "downloading-compiler" });
    try {
      await runner.initialize(true);
    } catch (error) {
      runner.terminate();
      throw error;
    }
    const session = {
      runner,
      xetex: this.factory.createXetex(runner),
      pdftex: this.factory.createPdftex(runner),
    };
    this.session = session;
    return session;
  }

  private discardSession() {
    this.session?.runner.terminate();
    this.session = null;
  }
}
