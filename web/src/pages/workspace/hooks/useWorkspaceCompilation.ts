import { useActorRef, useSelector } from "@xstate/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  useCompilationEnvironment,
  type CompilationEnvironment,
} from "@/compilation/compilationEnvironment";
import {
  localizeClientError,
  type Translator,
  type UiLocale,
} from "@/lib/i18n";
import {
  compileLatexClientSide,
  subscribeLatexRuntimeStatus,
  type LatexRuntimeStatus,
} from "@/lib/latex";
import {
  compileTypstClientSide,
  subscribeTypstRuntimeStatus,
  type TypstRuntimeStatus,
} from "@/lib/typst";
import {
  pdfExportMachine,
  selectCompilationArtifacts,
  sameCompileProduct,
  sameCompileRequest,
  workspaceCompilationMachine,
  type TypstMappingState,
  type WorkspaceCompileJob,
  type WorkspaceCompileOutput,
} from "@/pages/workspace/compilationActor";
import {
  compileWorldFontData,
  type CompileTarget,
  type CompileWorld,
} from "@/pages/workspace/compileWorld";

const INITIAL_COMPILE_DEBOUNCE_MS = 0;
const LIVE_COMPILE_DEBOUNCE_MS = 120;

type CompileRuntimeStatus = TypstRuntimeStatus | LatexRuntimeStatus;

type UseWorkspaceCompilationInput = {
  projectId: string;
  sessionGeneration: string;
  workspaceLoaded: boolean;
  showPreview: boolean;
  isRevisionMode: boolean;
  workspaceSyncPending: boolean;
  hasActiveLiveDoc: boolean;
  activeLiveDocReady: boolean;
  world: CompileWorld;
  target: CompileTarget;
  requiredAssetPaths: string[];
  loadedAssetBase64: Record<string, string>;
  failedAssetPathsRef: MutableRefObject<Set<string>>;
  locale: UiLocale;
  t: Translator;
};

async function compileWorkspace(
  environment: CompilationEnvironment,
  job: WorkspaceCompileJob,
) {
  const documents = job.world.documents.slice();
  const assets = job.world.assets.slice();
  if (job.target.kind === "latex") {
    return compileLatexClientSide({
      workspaceKey: job.world.scope,
      entryFilePath: job.world.entryFilePath,
      documents,
      assets,
      environment: environment.latex,
      engine: job.target.engine,
    });
  }
  return compileTypstClientSide({
    workspaceKey: job.world.scope,
    entryFilePath: job.world.entryFilePath,
    documents,
    assets,
    environment: environment.typst,
    fontData: compileWorldFontData(job.world).slice(),
    emitPdf: job.target.emitPdf,
  });
}

async function generateTypstPdf(
  environment: CompilationEnvironment,
  job: WorkspaceCompileJob,
) {
  if (job.target.kind !== "typst") {
    throw new Error("Only Typst compilation jobs support browser PDF export");
  }
  return compileTypstClientSide({
    workspaceKey: job.world.scope,
    entryFilePath: job.world.entryFilePath,
    documents: job.world.documents.slice(),
    assets: job.world.assets.slice(),
    environment: environment.typst,
    fontData: compileWorldFontData(job.world).slice(),
    emitPdf: true,
    pdfOnly: true,
  });
}

function downloadPdfBytes(bytes: Uint8Array, entryFilePath: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = entryFilePath.replace(/\.(?:typ|tex|ltx)$/i, "") + ".pdf";
  anchor.click();
  URL.revokeObjectURL(url);
}

export { type TypstMappingState } from "@/pages/workspace/compilationActor";

export function useWorkspaceCompilation({
  projectId,
  sessionGeneration,
  workspaceLoaded,
  showPreview,
  isRevisionMode,
  workspaceSyncPending,
  hasActiveLiveDoc,
  activeLiveDocReady,
  world,
  target,
  requiredAssetPaths,
  loadedAssetBase64,
  failedAssetPathsRef,
  locale,
  t,
}: UseWorkspaceCompilationInput) {
  const compilationEnvironment = useCompilationEnvironment();
  const [runtimeStatus, setRuntimeStatus] = useState<CompileRuntimeStatus>({
    stage: "idle",
  });
  const compileJob = useMemo<WorkspaceCompileJob>(
    () => ({
      sessionGeneration,
      world,
      target,
    }),
    [sessionGeneration, target, world],
  );
  const currentCompileJobRef = useRef(compileJob);
  currentCompileJobRef.current = compileJob;
  const compilationActor = useActorRef(workspaceCompilationMachine, {
    input: {
      initialSessionGeneration: sessionGeneration,
      initialDebounceMs: INITIAL_COMPILE_DEBOUNCE_MS,
      liveDebounceMs: LIVE_COMPILE_DEBOUNCE_MS,
      compile: (job) => compileWorkspace(compilationEnvironment, job),
    },
  });
  const exportActor = useActorRef(pdfExportMachine, {
    input: {
      initialSessionGeneration: sessionGeneration,
      isCurrent: (job: WorkspaceCompileJob) =>
        sameCompileProduct(currentCompileJobRef.current, job),
      generate: (job) => generateTypstPdf(compilationEnvironment, job),
      onOutput: (job: WorkspaceCompileJob, output: WorkspaceCompileOutput) => {
        compilationActor.send({ type: "export.output", job, output });
      },
      onError: (job: WorkspaceCompileJob, error: unknown) => {
        compilationActor.send({ type: "export.error", job, error });
      },
      download: downloadPdfBytes,
    },
  });
  const compilationSnapshot = useSelector(
    compilationActor,
    (snapshot) => snapshot,
  );
  const exportSnapshot = useSelector(exportActor, (snapshot) => snapshot);

  useEffect(() => {
    compilationActor.send({ type: "session.started", sessionGeneration });
    exportActor.send({ type: "session.started", sessionGeneration });
  }, [compilationActor, exportActor, sessionGeneration]);

  useEffect(() => {
    const unsubscribe =
      target.kind === "latex"
        ? subscribeLatexRuntimeStatus(setRuntimeStatus)
        : subscribeTypstRuntimeStatus(setRuntimeStatus);
    return unsubscribe;
  }, [target.kind]);

  useEffect(() => {
    if (
      !projectId ||
      !workspaceLoaded ||
      !showPreview ||
      (!isRevisionMode && workspaceSyncPending) ||
      (!isRevisionMode && hasActiveLiveDoc && !activeLiveDocReady)
    ) {
      compilationActor.send({ type: "pause" });
      return;
    }
    if (world.documents.length === 0) {
      compilationActor.send({ type: "empty" });
      return;
    }
    const hasPendingAssets =
      !isRevisionMode &&
      requiredAssetPaths.some(
        (path) =>
          !loadedAssetBase64[path] && !failedAssetPathsRef.current.has(path),
      );
    if (hasPendingAssets) {
      compilationActor.send({ type: "pause" });
      return;
    }
    compilationActor.send({ type: "compile", job: compileJob });
  }, [
    activeLiveDocReady,
    compilationActor,
    compileJob,
    failedAssetPathsRef,
    hasActiveLiveDoc,
    isRevisionMode,
    loadedAssetBase64,
    projectId,
    requiredAssetPaths,
    showPreview,
    world.documents.length,
    workspaceLoaded,
    workspaceSyncPending,
  ]);

  const actorSessionIsCurrent =
    compilationSnapshot.context.sessionGeneration === sessionGeneration;
  const storedArtifact = compilationSnapshot.context.artifact;
  const selectedArtifacts = actorSessionIsCurrent
    ? selectCompilationArtifacts(storedArtifact, compileJob)
    : {
        current: null,
        vector: null,
        pdf: null,
        mapping: null,
        vectorOutdated: false,
        pdfOutdated: false,
      };
  const { current: artifact, mapping } = selectedArtifacts;
  const mappingRef = useRef<TypstMappingState | null>(mapping);
  mappingRef.current = mapping;
  let errors = (artifact?.errors ?? []).map((message) =>
    localizeClientError(locale, message),
  );
  if (
    actorSessionIsCurrent &&
    compilationSnapshot.context.noSourceDocuments &&
    world.documents.length === 0
  ) {
    errors = [t("errors.noSourceDocuments")];
  } else if (
    actorSessionIsCurrent &&
    sameCompileRequest(compilationSnapshot.context.job, compileJob) &&
    compilationSnapshot.context.operationError
  ) {
    const { operation, cause } = compilationSnapshot.context.operationError;
    errors = [
      cause instanceof Error
        ? localizeClientError(locale, cause.message)
        : t(
            operation === "pdfExport"
              ? "errors.pdfExport"
              : "errors.typstCompile",
          ),
    ];
  }

  const reportPreviewError = useCallback(
    (message: string) => {
      compilationActor.send({
        type: "preview.error",
        job: compileJob,
        message,
      });
    },
    [compilationActor, compileJob],
  );

  const downloadPdf = useCallback(() => {
    const job = compilationActor.getSnapshot().context.job;
    if (!sameCompileRequest(job, compileJob)) return;
    const currentArtifact = compilationActor.getSnapshot().context.artifact;
    const cachedPdf =
      currentArtifact.pdf &&
      sameCompileProduct(currentArtifact.pdf.job, compileJob)
        ? currentArtifact.pdf.data
        : null;
    exportActor.send({ type: "export", job: compileJob, cachedPdf });
  }, [compilationActor, compileJob, exportActor]);

  return {
    vectorData: selectedArtifacts.vector?.data ?? null,
    vectorDataOutdated: selectedArtifacts.vectorOutdated,
    mapping,
    mappingRef,
    pdfData: selectedArtifacts.pdf?.data ?? null,
    pdfDataOutdated: selectedArtifacts.pdfOutdated,
    errors,
    diagnostics: artifact?.diagnostics ?? [],
    active:
      actorSessionIsCurrent &&
      sameCompileRequest(compilationSnapshot.context.job, compileJob) &&
      compilationSnapshot.matches("compiling"),
    runtimeStatus,
    pdfExportActive:
      exportSnapshot.context.sessionGeneration === sessionGeneration &&
      sameCompileProduct(exportSnapshot.context.job, compileJob) &&
      exportSnapshot.matches("generating"),
    reportPreviewError,
    downloadPdf,
  };
}
